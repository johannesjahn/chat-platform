import { HttpApiBuilder } from "effect/http-api";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { Cache, Effect, Metric } from "effect";
import { setLogUser } from "./RedactedLogger.ts";
import {
  ALLOWED_AVATAR_MIME_TYPES,
  type AuthMethod,
  AvatarTooLarge,
  ChatApi,
  DEFAULT_POSTS_LIMIT,
  Forbidden,
  InvalidAvatarUpload,
  InvalidBlockRequest,
  InvalidCredentials,
  InvalidPostsRequest,
  InvalidUsernameLookupRequest,
  InvalidUserSearchRequest,
  MAX_AVATAR_UPLOAD_SIZE_BYTES,
  MAX_USERNAME_LOOKUP_COUNT,
  MIN_USER_SEARCH_QUERY_LENGTH,
  NotFound,
  TooManyRequests,
  UsernameTaken,
} from "./Api.ts";
import { resolveAttachments } from "./attachments.ts";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import { CurrentUser, TokenVersionCache } from "./Auth.ts";
import { blockedOrMutedUserIds } from "./blocks.ts";
import {
  avatarStorageKey,
  avatarUrlForToken,
  generateAvatarToken,
} from "./avatars.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { GoogleIdToken } from "./GoogleIdToken.ts";
import { processAvatar } from "./ImageProcessing.ts";
import { withMediaProcessingPermit } from "./MediaProcessingLimit.ts";
import { Jwt, type TokenUser } from "./Jwt.ts";
import { authEventsTotal, rateLimitRejectionsTotal } from "./Metrics.ts";
import {
  decodePostsCursor,
  encodePostsCursor,
  postCommentCounts,
  toApiPost,
} from "./PostsHandler.ts";
import { PubSub } from "./PubSub.ts";
import { postReactionInfo } from "./reactions.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { clientIp } from "./ClientIp.ts";
import { RateLimiter, type RateLimitResult } from "./RateLimiter.ts";
import { containsPattern } from "./search.ts";
import {
  attachments,
  refreshTokens,
  userBlocks,
  users,
  posts,
} from "./db/schema.ts";

// Sensible defaults for auth-endpoint rate limiting (see issue #25). Login is
// capped per source IP (every attempt counts) and per targeted account — but
// the account buckets effectively count only *failed* attempts (issue #480):
// every attempt consumes them up front, so concurrent guesses can't race past
// the limit (issue #543), and a successful login then clears the account+IP
// bucket and refunds its own unit on the account-wide one, so signing in on
// several devices never locks the owner out. The tight account bucket is also keyed by IP, so an attacker
// hammering wrong passwords for someone's username only locks *themselves*
// out of that account; the looser account-wide ceiling still bounds how many
// guesses a distributed attacker (many IPs) gets per window.
const LOGIN_MAX_ATTEMPTS_PER_IP = 20;
const LOGIN_MAX_FAILURES_PER_ACCOUNT_AND_IP = 5;
const LOGIN_MAX_FAILURES_PER_ACCOUNT = 50;
const LOGIN_WINDOW_SECONDS = 15 * 60;

// Google sign-in has no account bucket to key on before the token is
// verified, and a guess can't succeed without Google's signature anyway — so
// it's capped per IP only, with login's per-IP budget.
const GOOGLE_LOGIN_MAX_ATTEMPTS_PER_IP = LOGIN_MAX_ATTEMPTS_PER_IP;
const GOOGLE_LOGIN_WINDOW_SECONDS = LOGIN_WINDOW_SECONDS;

// Registration has no natural "account" bucket (that's what's being
// created), so it's capped per IP only.
const REGISTER_MAX_ATTEMPTS_PER_IP = 5;
const REGISTER_WINDOW_SECONDS = 60 * 60;

// Deleting a Google account re-confirms with a Google sign-in made just now,
// not whichever ID token the browser last saw (those live for an hour).
const DELETE_ACCOUNT_GOOGLE_MAX_AGE_SECONDS = 5 * 60;

// Refreshing is routine/automatic (a client does it roughly once per access
// token lifetime), so its limit is looser than login's — it exists mainly as
// a ceiling against refresh-token guessing, not to constrain normal use.
const REFRESH_MAX_ATTEMPTS_PER_IP = 60;
const REFRESH_WINDOW_SECONDS = 15 * 60;

// Caps a single search response regardless of how many usernames match, so
// the payload stays bounded independent of the user base's size.
const USER_SEARCH_RESULTS_LIMIT = 20;

// Bounds how many current-password guesses a caller (who must already hold a
// valid access token) can make before being locked out — mirrors login's
// per-account bucket, keyed by user id rather than username.
const CHANGE_PASSWORD_MAX_ATTEMPTS_PER_ACCOUNT = 5;
const CHANGE_PASSWORD_WINDOW_SECONDS = 15 * 60;

// Deleting an account re-verifies the password, same brute-force exposure as
// changePassword — mirrors its limit/window.
const DELETE_ACCOUNT_MAX_ATTEMPTS_PER_ACCOUNT = 5;
const DELETE_ACCOUNT_WINDOW_SECONDS = 15 * 60;

// Avatar uploads involve real image-decoding/resizing work (processAvatar,
// ImageProcessing.ts) and are a rare, deliberate action (changing your
// avatar), not something a normal client ever does in a burst — mirrors
// AttachmentsHandler's enforceUploadLimit's rationale for bounding a
// scripted flood tighter than the global per-IP limiter.
const AVATAR_UPLOAD_MAX_ATTEMPTS_PER_ACCOUNT = 10;
const AVATAR_UPLOAD_WINDOW_SECONDS = 60 * 60;

// Consumes `key` from the rate limiter and fails with TooManyRequests if the
// caller has exceeded `limit` calls within `windowSeconds`. The failure
// message is deliberately generic — it must never reveal which bucket (IP
// vs. account) tripped, so it can't be used to enumerate accounts. On a
// rejection, `rate_limit_rejections_total` is labeled only by the bucket
// *kind* (the part of `key` before its first ":", e.g. "login"/"register") —
// never by the IP/account/user id the rest of `key` encodes.
// Exported — shared with ChatsHandler.ts's group-avatar upload, which needs
// the same per-account bucketing/rejection-metric behavior.
export const enforceRateLimit = (
  limiter: RateLimiter["Service"],
  key: string,
  limit: number,
  windowSeconds: number,
): Effect.Effect<void, TooManyRequests> =>
  Effect.flatMap(limiter.consume(key, limit, windowSeconds), (result) =>
    rejectIfLimited(key, result),
  );

const rejectIfLimited = (
  key: string,
  result: RateLimitResult,
): Effect.Effect<void, TooManyRequests> =>
  Effect.gen(function* () {
    if (!result.allowed) {
      yield* Metric.update(
        Metric.withAttributes(rateLimitRejectionsTotal, {
          limiter: key.split(":")[0] ?? key,
        }),
        1,
      );
      return yield* Effect.fail(
        new TooManyRequests({
          message: "Too many requests. Please try again later.",
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
    }
  });

// Columns every "return a User" query below selects, and the shape
// `toPublicUser` transforms them from — `avatarSmallKey`/`avatarMediumKey`/
// `avatarLargeKey` (three flat DB columns holding object-storage tokens since
// issue #289) fold into the API's single nested `avatarVariants` field of
// proxy URLs, present only when all three are set (they're always
// written/cleared together — see updateProfile/uploadAvatar below).
type UserRow = {
  id: number;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarSmallKey: string | null;
  avatarMediumKey: string | null;
  avatarLargeKey: string | null;
  role: "user" | "admin";
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: Date | null;
};

// Folds the three stored avatar tokens into the API's `avatarVariants` shape,
// turning each into the long-cache proxy URL that serves it (see
// avatarUrlForToken / AvatarRoute.ts). Shared with ChatsHandler.ts and
// SearchHandler.ts, which need the same fold for a chat participant's avatar
// columns (see ChatParticipant in Api.ts).
export const toAvatarVariants = (row: {
  avatarSmallKey: string | null;
  avatarMediumKey: string | null;
  avatarLargeKey: string | null;
}) =>
  row.avatarSmallKey && row.avatarMediumKey && row.avatarLargeKey
    ? {
        small: avatarUrlForToken(row.avatarSmallKey),
        medium: avatarUrlForToken(row.avatarMediumKey),
        large: avatarUrlForToken(row.avatarLargeKey),
      }
    : null;

// Best-effort removal of an old avatar's variant objects once the row has
// stopped pointing at them (a re-upload, a clear via updateProfile, or account
// deletion). Best-effort — an orphaned object is a harmless storage leak, not
// a correctness problem, so a delete failure must never fail the user-facing
// write. `null` tokens (no prior uploaded avatar) are skipped. Exported —
// shared with ChatsHandler.ts's group-avatar upload/clear, which sweeps a
// chat's old avatar objects the same way.
export const deleteAvatarObjects = (
  storage: AttachmentStorage["Service"],
  tokens: ReadonlyArray<string | null>,
): Effect.Effect<void> =>
  Effect.forEach(
    tokens.filter((token): token is string => token !== null),
    (token) => storage.delete(avatarStorageKey(token)).pipe(Effect.ignore),
    { discard: true },
  );

// How many attachment objects `deleteUserAndObjects` removes from the bucket
// at once — an account can have thousands, and one at a time would hold the
// delete request open for as many S3 round trips.
const ACCOUNT_OBJECT_DELETE_CONCURRENCY = 8;

// Deletes a `users` row — whose cascading/`set null` FKs (db/schema.ts) take
// care of everything else the account owns in the database — and then,
// best-effort, the storage objects that cascade would otherwise orphan for
// good: the avatar variants (`avatarTokens`, read by the caller) and every
// attachment the account uploaded (issue #652). Neither is reachable by
// AttachmentCleanup.ts's sweep, which walks `attachments` rows, so once the
// rows are gone nothing else would ever find the objects. The attachment rows
// are deleted explicitly, in the same transaction as the user, so the keys
// swept are exactly the rows removed.
const deleteUserAndObjects = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  userId: number,
  avatarTokens: ReadonlyArray<string | null>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const storageKeys = yield* Effect.tryPromise(() =>
      db.transaction(async (tx) => {
        const removed = await tx
          .delete(attachments)
          .where(eq(attachments.uploaderId, userId))
          .returning({ storageKey: attachments.storageKey });
        await tx.delete(users).where(eq(users.id, userId));
        return removed.map((row) => row.storageKey);
      }),
    ).pipe(Effect.orDie);

    yield* deleteAvatarObjects(storage, avatarTokens);
    yield* Effect.forEach(
      storageKeys,
      (key) => storage.delete(key).pipe(Effect.ignore),
      { discard: true, concurrency: ACCOUNT_OBJECT_DELETE_CONCURRENCY },
    );
  });

// A status past its `statusExpiresAt` is treated as fully unset wherever a
// user is read, rather than needing a background sweep to null the columns
// out — mirrors `toAvatarVariants`'s role of folding raw DB columns into the
// API shape. Shared with ChatsHandler.ts for the same reason `toAvatarVariants`
// is.
export const effectiveStatus = (row: {
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: Date | null;
}): {
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: number | null;
} => {
  if (row.statusExpiresAt && row.statusExpiresAt.getTime() <= Date.now()) {
    return { statusText: null, statusEmoji: null, statusExpiresAt: null };
  }
  return {
    statusText: row.statusText,
    statusEmoji: row.statusEmoji,
    statusExpiresAt: row.statusExpiresAt ? row.statusExpiresAt.getTime() : null,
  };
};

export const toPublicUser = (row: UserRow) => ({
  id: row.id,
  username: row.username,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl,
  avatarVariants: toAvatarVariants(row),
  role: row.role,
  ...effectiveStatus(row),
});

// `getUser`/`updateProfile` return the profile view (issue #322): the public
// user plus its bio.
const toUserProfile = (row: UserRow & { bio: string | null }) => ({
  ...toPublicUser(row),
  bio: row.bio,
});

// The `users` columns every "return a public User" query selects, folded into
// the API shape by `toPublicUser`. Named so the block/mute handlers below (and
// GamesHandler.ts) can select the same set off a join against `users` without
// re-listing it (the older handlers above still inline it, matching their
// original style).
export const publicUserColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  avatarSmallKey: users.avatarSmallKey,
  avatarMediumKey: users.avatarMediumKey,
  avatarLargeKey: users.avatarLargeKey,
  role: users.role,
  statusText: users.statusText,
  statusEmoji: users.statusEmoji,
  statusExpiresAt: users.statusExpiresAt,
} as const;

// Auth funnel counter (issue #196) — labeled only by `event`
// ("google_login"/"google_signup"/"login"/"refresh") and `outcome`
// ("success"/"failure"), never by username/user id. A request rejected by enforceRateLimit above is counted
// there instead (as a rate_limit_rejections_total, not an auth_events_total
// failure), so a single rejected request isn't double-counted across both
// metrics.
const recordAuthEvent = (
  event: "google_login" | "google_signup" | "login" | "refresh",
  outcome: "success" | "failure",
) =>
  Metric.update(
    Metric.withAttributes(authEventsTotal, { event: event, outcome: outcome }),
    1,
  );

// Issues a refresh token for `user` and persists its jti so `POST
// /users/refresh` can later look it up — a refresh token is only honored
// while its row is present and unrevoked. Each call starts a new family
// (a fresh login); refreshes go through `rotateRefreshToken` instead.
const issueRefreshToken = (
  db: DrizzleDb,
  jwt: Jwt["Service"],
  user: TokenUser,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const { token, jti, expiresAt } = yield* jwt.signRefreshToken(user);
    yield* Effect.tryPromise(() =>
      db.insert(refreshTokens).values({
        jti,
        userId: user.id,
        familyId: crypto.randomUUID(),
        expiresAt,
      }),
    ).pipe(Effect.orDie);
    return token;
  });

// Exchanges the refresh token `oldJti` for a new one in the same family:
// the old row is marked revoked (not deleted, so a later replay can still be
// recognised) and the new row inserted, in one transaction, so the old token
// stops working at the same instant the new one starts.
//
// The revoke is conditional on the row still being unrevoked, and that's
// what makes rotation single-use (issue #650). The caller has already read
// the row as unrevoked, but two requests presenting the same token can both
// get past that read before either writes. Under the condition only one of
// them gets a row back; Postgres re-checks `revoked_at IS NULL` once the
// winner's row lock is released. The loser gets `null` and inserts nothing.
// To the caller that's the same as finding the token already revoked.
const rotateRefreshToken = (
  db: DrizzleDb,
  jwt: Jwt["Service"],
  user: TokenUser,
  oldJti: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const { token, jti, expiresAt } = yield* jwt.signRefreshToken(user);
    const rotated = yield* Effect.tryPromise(() =>
      db.transaction(async (tx) => {
        const revoked = await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(
            and(eq(refreshTokens.jti, oldJti), isNull(refreshTokens.revokedAt)),
          )
          .returning({ familyId: refreshTokens.familyId });
        const familyId = revoked[0]?.familyId;
        if (familyId === undefined) return false;
        await tx
          .insert(refreshTokens)
          .values({ jti, userId: user.id, familyId, expiresAt });
        return true;
      }),
    ).pipe(Effect.orDie);
    return rotated ? token : null;
  });

// A fresh session for a user who just proved who they are — the same access
// + refresh pair whichever way they did it (issue #693: Google only replaces
// how identity is proven, not the session that follows).
const issueSession = (
  db: DrizzleDb,
  jwt: Jwt["Service"],
  user: UserRow & { tokenVersion: number },
  authMethod: AuthMethod,
) =>
  Effect.gen(function* () {
    const tokenUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      tokenVersion: user.tokenVersion,
    };
    const accessToken = yield* jwt.signAccessToken(tokenUser);
    const refreshToken = yield* issueRefreshToken(db, jwt, tokenUser);
    yield* setLogUser(user.username);
    return {
      user: toPublicUser(user),
      accessToken,
      refreshToken,
      authMethod,
    };
  });

// Revokes every still-active (unrevoked) row in a token family — called when
// a refresh token is replayed after having already been rotated away, which
// means it was stolen: the thief and the legitimate holder now both think
// they have a valid token, so the whole chain (including whatever the
// legitimate holder rotated to) is cut off, forcing a fresh login.
const revokeFamily = (db: DrizzleDb, familyId: string): Effect.Effect<void> =>
  Effect.tryPromise(() =>
    db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.familyId, familyId),
          isNull(refreshTokens.revokedAt),
        ),
      ),
  ).pipe(Effect.orDie, Effect.asVoid);

// Argon2id via Bun's built-in password hashing — no external dependency.
const hashPassword = (password: string): Effect.Effect<string> =>
  Effect.tryPromise(() =>
    Bun.password.hash(password, { algorithm: "argon2id" }),
  ).pipe(Effect.orDie);

const verifyPassword = (
  password: string,
  hash: string,
): Effect.Effect<boolean> =>
  Effect.tryPromise(() => Bun.password.verify(password, hash)).pipe(
    Effect.orDie,
  );

// A real argon2id hash (of an unguessable value) verified against when the
// supplied username doesn't exist. Verifying always fails but costs the same as
// a genuine verify, so login response time can't be used to enumerate accounts.
// Precomputed once at module load (same parameters as hashPassword) so no
// request ever pays the one-time hashing cost.
const dummyHashPromise = Bun.password.hash(crypto.randomUUID(), {
  algorithm: "argon2id",
});
const dummyHash = (): Effect.Effect<string> =>
  Effect.promise(() => dummyHashPromise);

export const UsersHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "users",
  Effect.fn(function* (handlers) {
    const db = yield* Db;
    const storage = yield* AttachmentStorage;
    const limiter = yield* RateLimiter;
    const connections = yield* RealtimeConnections;
    const pubsub = yield* PubSub;
    const jwt = yield* Jwt;
    const google = yield* GoogleIdToken;
    const tokenVersionCache = yield* TokenVersionCache;
    return handlers
      .handle("searchUsers", ({ query: { q } }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          // Only admins may browse the full directory — a query shorter
          // than the minimum keeps ILIKE's cost/result-size bounded (issue
          // #48) for anyone else.
          if (
            currentUser.role !== "admin" &&
            q.length < MIN_USER_SEARCH_QUERY_LENGTH
          )
            return yield* Effect.fail(
              new InvalidUserSearchRequest({
                message: `q must be at least ${MIN_USER_SEARCH_QUERY_LENGTH} characters`,
              }),
            );

          const pattern = containsPattern(q);
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
              })
              .from(users)
              // Matches a fragment of either name, not just the username —
              // both columns carry a GIN trigram index (migration 0023), so
              // this stays an index lookup rather than the sequential scan an
              // unanchored ILIKE used to force.
              .where(
                or(
                  ilike(users.username, pattern),
                  ilike(users.displayName, pattern),
                ),
              )
              .orderBy(users.username)
              .limit(USER_SEARCH_RESULTS_LIMIT),
          ).pipe(Effect.orDie);
          return rows.map(toPublicUser);
        }),
      )
      .handle("lookupUsersByUsername", ({ query: { usernames } }) =>
        Effect.gen(function* () {
          // The parameter is one comma-separated batch (see
          // `UsernameLookupQuery`); blanks and duplicates are dropped
          // before the cap is applied, so a sloppily-joined list ("a,,a")
          // costs a caller nothing.
          const names = [
            ...new Set(
              usernames
                .split(",")
                .map((name) => name.trim().toLowerCase())
                .filter((name) => name.length > 0),
            ),
          ];
          if (names.length > MAX_USERNAME_LOOKUP_COUNT)
            return yield* Effect.fail(
              new InvalidUsernameLookupRequest({
                message: `usernames must name at most ${MAX_USERNAME_LOOKUP_COUNT} users`,
              }),
            );
          if (names.length === 0) return [];

          const rows = yield* Effect.tryPromise(() =>
            db
              .select(publicUserColumns)
              .from(users)
              // `lower(username)` is exactly the expression the unique
              // index is built on (see db/schema.ts), so this stays an
              // index lookup rather than a scan.
              .where(inArray(sql`lower(${users.username})`, names))
              .orderBy(users.username),
          ).pipe(Effect.orDie);
          // Names with no account are simply missing from the result — the
          // client renders those mentions as plain text.
          return rows.map(toPublicUser);
        }),
      )
      .handle("getUser", ({ params: { id } }) =>
        Effect.gen(function* () {
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
                bio: users.bio,
              })
              .from(users)
              .where(eq(users.id, id))
              .limit(1),
          ).pipe(Effect.orDie);
          if (!rows[0])
            return yield* Effect.fail(
              new NotFound({ message: `User ${id} not found` }),
            );
          return toUserProfile(rows[0]);
        }),
      )
      .handle("listUserPosts", ({ params: { id }, query: urlParams }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const limit = urlParams.limit ?? DEFAULT_POSTS_LIMIT;

          const targetRows = yield* Effect.tryPromise(() =>
            db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, id))
              .limit(1),
          ).pipe(Effect.orDie);
          if (!targetRows[0])
            return yield* Effect.fail(
              new NotFound({ message: `User ${id} not found` }),
            );

          let after: number | null = null;
          if (urlParams.cursor !== undefined) {
            after = decodePostsCursor(urlParams.cursor);
            if (after === null)
              return yield* Effect.fail(
                new InvalidPostsRequest({ message: "Invalid cursor" }),
              );
          }

          // Same "fetch one row past `limit`" trick as `listPosts` to derive
          // `nextCursor` without a separate query (issue #51's rationale) —
          // `totalCount` below is the one place this endpoint does pay for a
          // dedicated `COUNT(*)`, since it's scoped to a single author and
          // backed by `posts_author_id_idx` rather than scanning all posts.
          const fetched = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(posts)
              .where(
                and(
                  eq(posts.authorId, id),
                  after !== null ? lt(posts.id, after) : undefined,
                ),
              )
              .orderBy(desc(posts.id))
              .limit(limit + 1),
          ).pipe(Effect.orDie);
          const hasMore = fetched.length > limit;
          const rows = fetched.slice(0, limit);
          const lastRow = rows[rows.length - 1];
          const nextCursor =
            hasMore && lastRow ? encodePostsCursor(lastRow.id) : null;

          const reactionInfo = yield* Effect.tryPromise(() =>
            postReactionInfo(
              db,
              rows.map((r) => r.id),
              currentUser.id,
            ),
          ).pipe(Effect.orDie);
          const commentCounts = yield* Effect.tryPromise(async () =>
            postCommentCounts(
              db,
              rows.map((r) => r.id),
              await blockedOrMutedUserIds(db, currentUser.id),
            ),
          ).pipe(Effect.orDie);
          const attachments = yield* resolveAttachments(
            db,
            storage,
            rows.map((r) => r.attachmentId),
          );
          const totalRows = yield* Effect.tryPromise(() =>
            db
              .select({ total: count() })
              .from(posts)
              .where(eq(posts.authorId, id)),
          ).pipe(Effect.orDie);

          return {
            posts: rows.map((r) =>
              toApiPost(
                r,
                reactionInfo.get(r.id),
                r.attachmentId !== null
                  ? (attachments.get(r.attachmentId) ?? null)
                  : null,
                commentCounts.get(r.id) ?? 0,
              ),
            ),
            limit,
            nextCursor,
            totalCount: Number(totalRows[0]?.total ?? 0),
          };
        }),
      )
      .handle("getAuthConfig", () =>
        Effect.succeed({ googleClientId: google.clientId }),
      )
      .handle("loginGoogle", ({ payload }) =>
        Effect.gen(function* () {
          const ip = yield* clientIp;
          yield* enforceRateLimit(
            limiter,
            `google-login:ip:${ip}`,
            GOOGLE_LOGIN_MAX_ATTEMPTS_PER_IP,
            GOOGLE_LOGIN_WINDOW_SECONDS,
          );

          const { sub } = yield* google.verify(payload.idToken).pipe(
            Effect.mapError(
              () =>
                new InvalidCredentials({
                  message: "Google sign-in failed. Please try again.",
                }),
            ),
            Effect.tapError(() => recordAuthEvent("google_login", "failure")),
          );

          const rows = yield* Effect.tryPromise(() =>
            db.select().from(users).where(eq(users.googleSub, sub)).limit(1),
          ).pipe(Effect.orDie);
          const user = rows[0];
          yield* recordAuthEvent("google_login", "success");
          if (!user) {
            // First sign-in. No row yet — `registerGoogle` creates it once a
            // username is picked, so an abandoned signup leaves nothing
            // behind and no placeholder name is ever visible to others.
            const pendingToken = yield* jwt.signGooglePendingToken(sub);
            return { needsUsername: true as const, pendingToken };
          }
          return yield* issueSession(db, jwt, user, "google");
        }),
      )
      .handle("registerGoogle", ({ payload }) =>
        Effect.gen(function* () {
          const ip = yield* clientIp;
          yield* enforceRateLimit(
            limiter,
            `register:ip:${ip}`,
            REGISTER_MAX_ATTEMPTS_PER_IP,
            REGISTER_WINDOW_SECONDS,
          );

          const { googleSub } = yield* jwt
            .verifyGooglePendingToken(payload.pendingToken)
            .pipe(
              Effect.mapError(
                () =>
                  new InvalidCredentials({
                    message:
                      "Your Google sign-in has expired. Please sign in again.",
                  }),
              ),
              Effect.tapError(() =>
                recordAuthEvent("google_signup", "failure"),
              ),
            );

          const usernameTaken = () =>
            Effect.gen(function* () {
              yield* recordAuthEvent("google_signup", "failure");
              return yield* Effect.fail(
                new UsernameTaken({
                  message: `Username "${payload.username}" is already taken`,
                }),
              );
            });

          const existing = yield* Effect.tryPromise(() =>
            db
              .select({ id: users.id })
              .from(users)
              .where(
                eq(
                  sql`lower(${users.username})`,
                  payload.username.toLowerCase(),
                ),
              )
              .limit(1),
          ).pipe(Effect.orDie);
          if (existing[0]) return yield* usernameTaken();

          // `onConflictDoNothing` rather than letting a unique violation
          // surface as a 500: a name taken between the check above and here,
          // or this Google account registered meanwhile (the form submitted
          // twice, two tabs), comes back as no row instead.
          const rows = yield* Effect.tryPromise(() =>
            db
              .insert(users)
              // Always a "user" — admins are promoted out-of-band or created
              // with scripts/create-admin.ts, never via this endpoint.
              .values({ username: payload.username, googleSub, role: "user" })
              .onConflictDoNothing()
              .returning(),
          ).pipe(Effect.orDie);
          const user = rows[0];
          if (!user) {
            const registered = yield* Effect.tryPromise(() =>
              db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.googleSub, googleSub))
                .limit(1),
            ).pipe(Effect.orDie);
            if (!registered[0]) return yield* usernameTaken();
            yield* recordAuthEvent("google_signup", "failure");
            return yield* Effect.fail(
              new InvalidCredentials({
                message:
                  "This Google account already has an account. Please sign in again.",
              }),
            );
          }
          yield* recordAuthEvent("google_signup", "success");
          return yield* issueSession(db, jwt, user, "google");
        }),
      )
      .handle("login", ({ payload }) =>
        Effect.gen(function* () {
          const ip = yield* clientIp;
          yield* enforceRateLimit(
            limiter,
            `login:ip:${ip}`,
            LOGIN_MAX_ATTEMPTS_PER_IP,
            LOGIN_WINDOW_SECONDS,
          );
          const account = payload.username.toLowerCase();
          const accountIpKey = `login:account-ip:${account}:${ip}`;
          const accountKey = `login:account:${account}`;
          // Both account buckets are consumed atomically *before* the
          // (slow, async) password check — a check-then-consume would let
          // concurrent guesses all pass the check before any of them counted
          // (issue #543). A success hands its unit back below.
          yield* enforceRateLimit(
            limiter,
            accountIpKey,
            LOGIN_MAX_FAILURES_PER_ACCOUNT_AND_IP,
            LOGIN_WINDOW_SECONDS,
          );
          yield* enforceRateLimit(
            limiter,
            accountKey,
            LOGIN_MAX_FAILURES_PER_ACCOUNT,
            LOGIN_WINDOW_SECONDS,
          );
          const rows = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(users)
              .where(
                eq(
                  sql`lower(${users.username})`,
                  payload.username.toLowerCase(),
                ),
              )
              .limit(1),
          ).pipe(Effect.orDie);

          // Always run a verify — against a dummy hash when the user is
          // missing or has no password (a Google account) — so timing
          // doesn't reveal whether the username exists or how it signs in.
          // Only an admin may sign in with a password at all (issue #693);
          // anyone else is refused exactly like a wrong password.
          const user = rows[0];
          const hash = user?.passwordHash ?? (yield* dummyHash());
          const valid = yield* verifyPassword(payload.password, hash);
          if (
            !user ||
            user.passwordHash === null ||
            user.role !== "admin" ||
            !valid
          ) {
            yield* recordAuthEvent("login", "failure");
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid username or password",
              }),
            );
          }

          // Success: forgive this IP's failures against the account, but
          // only refund this one attempt on the account-wide bucket — wiping
          // it would erase a distributed attacker's tally whenever the owner
          // signs in.
          yield* limiter.reset(accountIpKey);
          yield* limiter.refund(accountKey);

          yield* recordAuthEvent("login", "success");
          return yield* issueSession(db, jwt, user, "password");
        }),
      )
      .handle("refresh", ({ payload }) =>
        Effect.gen(function* () {
          const ip = yield* clientIp;
          yield* enforceRateLimit(
            limiter,
            `refresh:ip:${ip}`,
            REFRESH_MAX_ATTEMPTS_PER_IP,
            REFRESH_WINDOW_SECONDS,
          );

          const tokenUser = yield* jwt
            .verifyRefreshToken(payload.refreshToken)
            .pipe(
              Effect.mapError(
                () =>
                  new InvalidCredentials({
                    message: "Invalid or expired refresh token",
                  }),
              ),
              Effect.tapError(() => recordAuthEvent("refresh", "failure")),
            );

          // Reject anything not present in the server-side store — a
          // signature- and expiry-valid token whose row is gone (never
          // issued by this server, or already reclaimed after expiry) is
          // refused rather than trusted on claims alone.
          const stored = yield* Effect.tryPromise(() =>
            db
              .select({
                familyId: refreshTokens.familyId,
                revokedAt: refreshTokens.revokedAt,
              })
              .from(refreshTokens)
              .where(eq(refreshTokens.jti, tokenUser.jti))
              .limit(1),
          ).pipe(Effect.orDie);
          const storedToken = stored[0];
          if (!storedToken) {
            yield* recordAuthEvent("refresh", "failure");
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid or expired refresh token",
              }),
            );
          }

          // The row is still there but already revoked — either explicitly
          // (logout) or, most notably, by rotation: this exact token was
          // already exchanged for a newer one once before. Presenting it
          // again means someone other than whoever holds the current token
          // has a copy, i.e. it was stolen. Revoke the rest of the family
          // (including whatever it was rotated to) so the thief and the
          // legitimate holder both get logged out and have to re-authenticate.
          if (storedToken.revokedAt) {
            yield* revokeFamily(db, storedToken.familyId);
            yield* recordAuthEvent("refresh", "failure");
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid or expired refresh token",
              }),
            );
          }

          // Re-fetch rather than trust the token's claims, so a deleted
          // account or a role change since the refresh token was issued
          // takes effect immediately instead of surviving up to its full TTL.
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: users.id,
                username: users.username,
                role: users.role,
                tokenVersion: users.tokenVersion,
              })
              .from(users)
              .where(eq(users.id, tokenUser.id))
              .limit(1),
          ).pipe(Effect.orDie);
          const dbUser = rows[0];
          // Also reject if the presented token was signed under an older
          // token_version — it survived the store lookup above (rotation
          // doesn't touch other users' rows), but a version bump since
          // issuance means it must not be trusted regardless.
          if (!dbUser || dbUser.tokenVersion !== tokenUser.tokenVersion) {
            yield* recordAuthEvent("refresh", "failure");
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid or expired refresh token",
              }),
            );
          }

          const publicUser = {
            id: dbUser.id,
            username: dbUser.username,
            role: dbUser.role,
          };
          const newTokenUser = {
            ...publicUser,
            tokenVersion: dbUser.tokenVersion,
          };
          const accessToken = yield* jwt.signAccessToken(newTokenUser);
          const refreshToken = yield* rotateRefreshToken(
            db,
            jwt,
            newTokenUser,
            tokenUser.jti,
          );
          // Another request rotated this same token between the read above
          // and now. Only one of them may win, and one token presented twice
          // is reuse whatever the timing, so this gets the same treatment as
          // the already-revoked case above.
          if (refreshToken === null) {
            yield* revokeFamily(db, storedToken.familyId);
            yield* recordAuthEvent("refresh", "failure");
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid or expired refresh token",
              }),
            );
          }
          yield* recordAuthEvent("refresh", "success");
          return { accessToken, refreshToken };
        }),
      )
      .handle("logout", ({ payload }) =>
        Effect.gen(function* () {
          // A token that's already invalid, expired, or unrecognized has
          // nothing to revoke — treat logout as a no-op success rather than
          // erroring, so the client can always clear its session cleanly.
          const tokenUser = yield* jwt
            .verifyRefreshToken(payload.refreshToken)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (!tokenUser) return;

          yield* Effect.tryPromise(() =>
            payload.allSessions
              ? // A "forced logout" of every session: besides revoking the
                // refresh tokens, bump token_version so any access token
                // already issued (and still within its own TTL) is cut off
                // immediately too, rather than remaining usable for up to 15
                // more minutes.
                db.transaction(async (tx) => {
                  await tx
                    .delete(refreshTokens)
                    .where(eq(refreshTokens.userId, tokenUser.id));
                  await tx
                    .update(users)
                    .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
                    .where(eq(users.id, tokenUser.id));
                })
              : db
                  .delete(refreshTokens)
                  .where(eq(refreshTokens.jti, tokenUser.jti)),
          ).pipe(Effect.orDie);

          yield* Cache.invalidate(tokenVersionCache, tokenUser.id);
          yield* pubsub
            .publish("auth:invalidation", String(tokenUser.id))
            .pipe(Effect.ignore);
          // Only "log out everywhere" revokes the other sessions' access
          // tokens, so only it closes their sockets — a single-session
          // logout leaves the user's other tabs connected.
          if (payload.allSessions) {
            yield* connections.disconnectUser(tokenUser.id);
          }
        }),
      )
      .handle("changePassword", ({ payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;

          yield* enforceRateLimit(
            limiter,
            `change-password:account:${currentUser.id}`,
            CHANGE_PASSWORD_MAX_ATTEMPTS_PER_ACCOUNT,
            CHANGE_PASSWORD_WINDOW_SECONDS,
          );

          const rows = yield* Effect.tryPromise(() =>
            db
              .select({ passwordHash: users.passwordHash })
              .from(users)
              .where(eq(users.id, currentUser.id))
              .limit(1),
          ).pipe(Effect.orDie);
          const dbUser = rows[0];
          if (dbUser && dbUser.passwordHash === null)
            return yield* Effect.fail(
              new Forbidden({
                message:
                  "This account signs in with Google and has no password to change",
              }),
            );
          const valid =
            dbUser &&
            dbUser.passwordHash !== null &&
            (yield* verifyPassword(
              payload.currentPassword,
              dbUser.passwordHash,
            ));
          if (!valid)
            return yield* Effect.fail(
              new InvalidCredentials({ message: "Incorrect current password" }),
            );

          const passwordHash = yield* hashPassword(payload.newPassword);

          // Revoking every refresh token and bumping token_version in the
          // same transaction as the password update mirrors `logout`'s
          // `allSessions` option: every other outstanding session (access and
          // refresh tokens alike) stops working immediately.
          const updated = yield* Effect.tryPromise(() =>
            db.transaction(async (tx) => {
              await tx
                .delete(refreshTokens)
                .where(eq(refreshTokens.userId, currentUser.id));
              const result = await tx
                .update(users)
                .set({
                  passwordHash,
                  tokenVersion: sql`${users.tokenVersion} + 1`,
                })
                .where(eq(users.id, currentUser.id))
                .returning({
                  id: users.id,
                  username: users.username,
                  role: users.role,
                  tokenVersion: users.tokenVersion,
                });
              return result[0];
            }),
          ).pipe(Effect.orDie);
          if (!updated)
            return yield* Effect.die(new Error("UPDATE returned no rows"));

          yield* Cache.invalidate(tokenVersionCache, currentUser.id);
          yield* pubsub
            .publish("auth:invalidation", String(currentUser.id))
            .pipe(Effect.ignore);
          yield* connections.disconnectUser(currentUser.id);

          // Reissue a fresh pair for this session — otherwise the caller
          // would be logged out by the very request that changed their
          // password, since the token_version bump above also invalidates
          // the access token used to authenticate this call.
          const tokenUser = {
            id: updated.id,
            username: updated.username,
            role: updated.role,
            tokenVersion: updated.tokenVersion,
          };
          const accessToken = yield* jwt.signAccessToken(tokenUser);
          const refreshToken = yield* issueRefreshToken(db, jwt, tokenUser);
          return { accessToken, refreshToken };
        }),
      )
      .handle("updateProfile", ({ payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;

          // Full-replace (see UpdateProfileBody's comment in Api.ts) also
          // clears any uploaded avatar — `avatarUrl` and the uploaded avatar
          // (legacy base64 columns + the object-storage `*Key` columns) are
          // mutually exclusive, so a caller explicitly setting (or clearing)
          // `avatarUrl` here always means "stop using the uploaded one".
          // `uploadAvatar` below is the inverse. Read the current `*Key` tokens
          // first so their storage objects can be swept once the row is cleared
          // (a `RETURNING` list reflects post-update values, i.e. the nulls).
          const prevRows = yield* Effect.tryPromise(() =>
            db
              .select({
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
              })
              .from(users)
              .where(eq(users.id, currentUser.id))
              .limit(1),
          ).pipe(Effect.orDie);
          const prev = prevRows[0];

          const rows = yield* Effect.tryPromise(() =>
            db
              .update(users)
              .set({
                displayName: payload.displayName,
                avatarUrl: payload.avatarUrl,
                avatarSmall: null,
                avatarMedium: null,
                avatarLarge: null,
                avatarSmallKey: null,
                avatarMediumKey: null,
                avatarLargeKey: null,
                // Omitted means "keep" (see UpdateProfileBody in Api.ts) —
                // Drizzle leaves an `undefined` column out of the SET list.
                bio: payload.bio,
              })
              .where(eq(users.id, currentUser.id))
              .returning({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
                bio: users.bio,
              }),
          ).pipe(Effect.orDie);
          const updated = rows[0];
          if (!updated)
            return yield* Effect.die(new Error("UPDATE returned no rows"));

          yield* deleteAvatarObjects(storage, [
            prev?.avatarSmallKey ?? null,
            prev?.avatarMediumKey ?? null,
            prev?.avatarLargeKey ?? null,
          ]);
          return toUserProfile(updated);
        }),
      )
      .handle("uploadAvatar", ({ payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;

          yield* enforceRateLimit(
            limiter,
            `avatar-upload:account:${currentUser.id}`,
            AVATAR_UPLOAD_MAX_ATTEMPTS_PER_ACCOUNT,
            AVATAR_UPLOAD_WINDOW_SECONDS,
          );

          if (
            !(ALLOWED_AVATAR_MIME_TYPES as ReadonlyArray<string>).includes(
              payload.file.contentType,
            )
          )
            return yield* Effect.fail(
              new InvalidAvatarUpload({
                message: `Unsupported file type: ${payload.file.contentType}`,
              }),
            );

          const bunFile = Bun.file(payload.file.path);
          if (bunFile.size > MAX_AVATAR_UPLOAD_SIZE_BYTES)
            return yield* Effect.fail(
              new AvatarTooLarge({
                message: `File exceeds the maximum size of ${MAX_AVATAR_UPLOAD_SIZE_BYTES} bytes`,
              }),
            );

          const processed = yield* Effect.tryPromise({
            try: async () =>
              processAvatar(await bunFile.bytes(), {
                x: payload.x,
                y: payload.y,
                size: payload.size,
              }),
            catch: (err) =>
              new InvalidAvatarUpload({
                message:
                  err instanceof Error ? err.message : "Invalid avatar image",
              }),
          }).pipe(withMediaProcessingPermit);

          // The tokens the row points at *before* this upload — their objects
          // become orphans once the row is repointed below, so sweep them
          // afterwards. Read up front (an UPDATE ... RETURNING would hand back
          // the post-update values, not these).
          const prevRows = yield* Effect.tryPromise(() =>
            db
              .select({
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
              })
              .from(users)
              .where(eq(users.id, currentUser.id))
              .limit(1),
          ).pipe(Effect.orDie);
          const prev = prevRows[0];

          // Mint a fresh token per variant and push the processed bytes to
          // object storage before touching the row — an upload that fails
          // partway leaves at most a few unreferenced objects (cleaned up like
          // any other orphan) rather than a row pointing at bytes that never
          // landed. Fresh tokens (never the previous upload's) are what make
          // the served URLs cache-bust on re-upload — see avatars.ts.
          const smallToken = generateAvatarToken();
          const mediumToken = generateAvatarToken();
          const largeToken = generateAvatarToken();
          yield* Effect.all(
            [
              storage.upload(
                avatarStorageKey(smallToken),
                processed.small,
                processed.contentType,
              ),
              storage.upload(
                avatarStorageKey(mediumToken),
                processed.medium,
                processed.contentType,
              ),
              storage.upload(
                avatarStorageKey(largeToken),
                processed.large,
                processed.contentType,
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.orDie);

          // Repoint the row at the freshly stored variants, nulling the legacy
          // base64 columns at the same time so a pre-#289 avatar's bytes stop
          // riding along in the row.
          const rows = yield* Effect.tryPromise(() =>
            db
              .update(users)
              .set({
                avatarUrl: null,
                avatarSmall: null,
                avatarMedium: null,
                avatarLarge: null,
                avatarSmallKey: smallToken,
                avatarMediumKey: mediumToken,
                avatarLargeKey: largeToken,
              })
              .where(eq(users.id, currentUser.id))
              .returning({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
              }),
          ).pipe(Effect.orDie);
          const updated = rows[0];
          if (!updated)
            return yield* Effect.die(new Error("UPDATE returned no rows"));

          yield* deleteAvatarObjects(storage, [
            prev?.avatarSmallKey ?? null,
            prev?.avatarMediumKey ?? null,
            prev?.avatarLargeKey ?? null,
          ]);
          return toPublicUser(updated);
        }),
      )
      .handle("deleteAccount", ({ payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;

          yield* enforceRateLimit(
            limiter,
            `delete-account:account:${currentUser.id}`,
            DELETE_ACCOUNT_MAX_ATTEMPTS_PER_ACCOUNT,
            DELETE_ACCOUNT_WINDOW_SECONDS,
          );

          // Also pull the avatar tokens, for `deleteUserAndObjects` to sweep
          // from the bucket once the row is gone.
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                passwordHash: users.passwordHash,
                googleSub: users.googleSub,
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
              })
              .from(users)
              .where(eq(users.id, currentUser.id))
              .limit(1),
          ).pipe(Effect.orDie);
          const dbUser = rows[0];
          if (!dbUser)
            return yield* Effect.fail(
              new InvalidCredentials({ message: "Incorrect password" }),
            );

          // A password account confirms with its password, a Google account
          // with a fresh Google sign-in for the *same* Google account — a
          // token for some other account of the caller's proves nothing.
          if ("password" in payload) {
            const valid =
              dbUser.passwordHash !== null &&
              (yield* verifyPassword(payload.password, dbUser.passwordHash));
            if (!valid)
              return yield* Effect.fail(
                new InvalidCredentials({ message: "Incorrect password" }),
              );
          } else {
            const confirmed = yield* google
              .verify(payload.idToken, {
                maxAgeSeconds: DELETE_ACCOUNT_GOOGLE_MAX_AGE_SECONDS,
              })
              .pipe(Effect.orElseSucceed(() => null));
            if (
              !confirmed ||
              dbUser.googleSub === null ||
              confirmed.sub !== dbUser.googleSub
            )
              return yield* Effect.fail(
                new InvalidCredentials({
                  message: "Couldn't confirm it's you with Google",
                }),
              );
          }

          yield* deleteUserAndObjects(db, storage, currentUser.id, [
            dbUser.avatarSmallKey,
            dbUser.avatarMediumKey,
            dbUser.avatarLargeKey,
          ]);

          yield* Cache.invalidate(tokenVersionCache, currentUser.id);
          yield* pubsub
            .publish("auth:invalidation", String(currentUser.id))
            .pipe(Effect.ignore);
          yield* connections.disconnectUser(currentUser.id);
        }),
      )
      .handle("updateUserRole", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;

          if (currentUser.role !== "admin")
            return yield* Effect.fail(
              new Forbidden({ message: "Only admins can change user roles" }),
            );

          // Bumps token_version so an access token already issued to the
          // target user can't keep acting under its old role for the rest of
          // its TTL — mirrors `changePassword`'s reasoning, since `role` is
          // embedded in the token's claims.
          const rows = yield* Effect.tryPromise(() =>
            db
              .update(users)
              .set({
                role: payload.role,
                tokenVersion: sql`${users.tokenVersion} + 1`,
              })
              .where(eq(users.id, id))
              .returning({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
              }),
          ).pipe(Effect.orDie);
          const updated = rows[0];
          if (!updated)
            return yield* Effect.fail(
              new NotFound({ message: `User ${id} not found` }),
            );

          yield* Cache.invalidate(tokenVersionCache, id);
          yield* pubsub
            .publish("auth:invalidation", String(id))
            .pipe(Effect.ignore);
          yield* connections.disconnectUser(id);

          return toPublicUser(updated);
        }),
      )
      .handle("deleteUser", ({ params: { id } }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;

          if (currentUser.role !== "admin")
            return yield* Effect.fail(
              new Forbidden({ message: "Only admins can delete users" }),
            );

          // Deleting your own account goes through `deleteAccount` (which
          // re-proves the password), not this admin endpoint — this rules out
          // an admin wiping their own account with a single unconfirmed click
          // and mirrors the frontend's role-management guard (see the
          // `!isSelf` check in web/src/routes/users/$id.tsx).
          if (currentUser.id === id)
            return yield* Effect.fail(
              new Forbidden({
                message:
                  "Admins can't delete their own account here — use account settings",
              }),
            );

          // Pull the avatar tokens first, for `deleteUserAndObjects` to sweep
          // — same as `deleteAccount` above.
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
              })
              .from(users)
              .where(eq(users.id, id))
              .limit(1),
          ).pipe(Effect.orDie);
          const dbUser = rows[0];
          if (!dbUser)
            return yield* Effect.fail(
              new NotFound({ message: `User ${id} not found` }),
            );

          yield* deleteUserAndObjects(db, storage, id, [
            dbUser.avatarSmallKey,
            dbUser.avatarMediumKey,
            dbUser.avatarLargeKey,
          ]);

          // Cut off the deleted user's outstanding access/refresh tokens
          // immediately rather than letting them live out their TTL — mirrors
          // `deleteAccount`.
          yield* Cache.invalidate(tokenVersionCache, id);
          yield* pubsub
            .publish("auth:invalidation", String(id))
            .pipe(Effect.ignore);
          yield* connections.disconnectUser(id);
        }),
      )
      .handle("updateStatus", ({ payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;

          // Omitted entirely means "never expires"; `requireStatusForExpiry`
          // in Api.ts already rejects it alongside a fully-cleared status.
          const statusExpiresAt =
            payload.expiresInMinutes !== undefined
              ? new Date(Date.now() + payload.expiresInMinutes * 60_000)
              : null;

          const rows = yield* Effect.tryPromise(() =>
            db
              .update(users)
              .set({
                statusText: payload.statusText,
                statusEmoji: payload.statusEmoji,
                statusExpiresAt,
              })
              .where(eq(users.id, currentUser.id))
              .returning({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmallKey: users.avatarSmallKey,
                avatarMediumKey: users.avatarMediumKey,
                avatarLargeKey: users.avatarLargeKey,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
              }),
          ).pipe(Effect.orDie);
          const updated = rows[0];
          if (!updated)
            return yield* Effect.die(new Error("UPDATE returned no rows"));

          const publicUser = toPublicUser(updated);
          yield* connections.notifyContacts(currentUser.id, {
            type: "status_changed",
            userId: currentUser.id,
            statusText: publicUser.statusText,
            statusEmoji: publicUser.statusEmoji,
            statusExpiresAt: publicUser.statusExpiresAt,
          });
          return publicUser;
        }),
      )
      .handle("listBlocks", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                ...publicUserColumns,
                blockType: userBlocks.type,
                blockedAt: userBlocks.createdAt,
              })
              .from(userBlocks)
              .innerJoin(users, eq(users.id, userBlocks.blockedId))
              // Newest relationship first — the order the settings card lists
              // them in. `id` (not `createdAt`) so re-issuing block↔mute on an
              // existing pair, which keeps the original row, doesn't reorder.
              .orderBy(desc(userBlocks.id))
              .where(eq(userBlocks.blockerId, currentUser.id)),
          ).pipe(Effect.orDie);
          return rows.map(({ blockType, blockedAt, ...userRow }) => ({
            user: toPublicUser(userRow),
            type: blockType,
            createdAt: blockedAt.getTime(),
          }));
        }),
      )
      .handle("setBlock", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;

          if (id === currentUser.id)
            return yield* Effect.fail(
              new InvalidBlockRequest({
                message: "You can't block or mute yourself",
              }),
            );

          // The target must exist — otherwise the FK would reject the insert
          // as a die; surface a clean 404 instead.
          const targetRows = yield* Effect.tryPromise(() =>
            db
              .select(publicUserColumns)
              .from(users)
              .where(eq(users.id, id))
              .limit(1),
          ).pipe(Effect.orDie);
          const target = targetRows[0];
          if (!target)
            return yield* Effect.fail(
              new NotFound({ message: `User ${id} not found` }),
            );

          // Upsert on the (blocker, blocked) unique constraint: a first block/
          // mute inserts, and re-issuing the other action on the same target
          // updates the existing row's `type` in place (keeping its original
          // `createdAt`) rather than stacking a second relationship.
          const inserted = yield* Effect.tryPromise(() =>
            db
              .insert(userBlocks)
              .values({
                blockerId: currentUser.id,
                blockedId: id,
                type: payload.type,
              })
              .onConflictDoUpdate({
                target: [userBlocks.blockerId, userBlocks.blockedId],
                set: { type: payload.type },
              })
              .returning({
                type: userBlocks.type,
                createdAt: userBlocks.createdAt,
              }),
          ).pipe(Effect.orDie);
          const row = inserted[0];
          if (!row)
            return yield* Effect.die(new Error("UPSERT returned no rows"));

          return {
            user: toPublicUser(target),
            type: row.type,
            createdAt: row.createdAt.getTime(),
          };
        }),
      )
      .handle("removeBlock", ({ params: { id } }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          // Idempotent — deleting a non-existent relationship is a no-op that
          // still succeeds, so unblocking/unmuting never 404s.
          yield* Effect.tryPromise(() =>
            db
              .delete(userBlocks)
              .where(
                and(
                  eq(userBlocks.blockerId, currentUser.id),
                  eq(userBlocks.blockedId, id),
                ),
              ),
          ).pipe(Effect.orDie);
        }),
      );
  }),
);
