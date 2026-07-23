import { HttpApiBuilder } from "@effect/platform";
import { and, eq, ilike, isNull, sql } from "drizzle-orm";
import { Context, Effect, FiberRef, Metric, MetricLabel } from "effect";
import { currentLogUser } from "./RedactedLogger.ts";
import {
  ALLOWED_AVATAR_MIME_TYPES,
  AvatarTooLarge,
  ChatApi,
  Forbidden,
  InvalidAvatarUpload,
  InvalidCredentials,
  MAX_AVATAR_UPLOAD_SIZE_BYTES,
  NotFound,
  TooManyRequests,
  UsernameTaken,
} from "./Api.ts";
import { CurrentUser, TokenVersionCache } from "./Auth.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { processAvatar } from "./ImageProcessing.ts";
import { Jwt, type TokenUser } from "./Jwt.ts";
import { authEventsTotal, rateLimitRejectionsTotal } from "./Metrics.ts";
import { PubSub } from "./PubSub.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { clientIp } from "./ClientIp.ts";
import { RateLimiter } from "./RateLimiter.ts";
import { refreshTokens, users } from "./db/schema.ts";

// Sensible defaults for auth-endpoint rate limiting (see issue #25). Login is
// capped both per source IP and per targeted account, so a single attacker
// can't brute-force one account from many IPs, or spray many accounts from
// one IP, without tripping a limit either way.
const LOGIN_MAX_ATTEMPTS_PER_IP = 20;
const LOGIN_MAX_ATTEMPTS_PER_ACCOUNT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

// Registration has no natural "account" bucket (that's what's being
// created), so it's capped per IP only.
const REGISTER_MAX_ATTEMPTS_PER_IP = 5;
const REGISTER_WINDOW_SECONDS = 60 * 60;

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

// Escapes LIKE/ILIKE wildcard characters in user-supplied search text so a
// query containing "%" or "_" is matched literally instead of as a wildcard.
const escapeLikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, (char) => `\\${char}`);

// Consumes `key` from the rate limiter and fails with TooManyRequests if the
// caller has exceeded `limit` calls within `windowSeconds`. The failure
// message is deliberately generic — it must never reveal which bucket (IP
// vs. account) tripped, so it can't be used to enumerate accounts. On a
// rejection, `rate_limit_rejections_total` is labeled only by the bucket
// *kind* (the part of `key` before its first ":", e.g. "login"/"register") —
// never by the IP/account/user id the rest of `key` encodes.
const enforceRateLimit = (
  limiter: Context.Tag.Service<typeof RateLimiter>,
  key: string,
  limit: number,
  windowSeconds: number,
): Effect.Effect<void, TooManyRequests> =>
  Effect.gen(function* () {
    const result = yield* limiter.consume(key, limit, windowSeconds);
    if (!result.allowed) {
      yield* Metric.update(
        Metric.taggedWithLabels(rateLimitRejectionsTotal, [
          MetricLabel.make("limiter", key.split(":")[0] ?? key),
        ]),
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
// `toPublicUser` transforms them from — `avatarSmall`/`avatarMedium`/
// `avatarLarge` (three flat DB columns, issue #269) fold into the API's
// single nested `avatarVariants` field, present only when all three are set
// (they're always written/cleared together — see updateProfile/uploadAvatar
// below).
type UserRow = {
  id: number;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarSmall: string | null;
  avatarMedium: string | null;
  avatarLarge: string | null;
  role: "user" | "admin";
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: Date | null;
};

// Shared with ChatsHandler.ts, which needs the same fold for a chat
// participant's avatar columns (see ChatParticipant in Api.ts).
export const toAvatarVariants = (row: {
  avatarSmall: string | null;
  avatarMedium: string | null;
  avatarLarge: string | null;
}) =>
  row.avatarSmall && row.avatarMedium && row.avatarLarge
    ? {
        small: row.avatarSmall,
        medium: row.avatarMedium,
        large: row.avatarLarge,
      }
    : null;

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

const toPublicUser = (row: UserRow) => ({
  id: row.id,
  username: row.username,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl,
  avatarVariants: toAvatarVariants(row),
  role: row.role,
  ...effectiveStatus(row),
});

// Auth funnel counter (issue #196) — labeled only by `event`
// ("signup"/"login"/"refresh") and `outcome` ("success"/"failure"), never by
// username/user id. A request rejected by enforceRateLimit above is counted
// there instead (as a rate_limit_rejections_total, not an auth_events_total
// failure), so a single rejected request isn't double-counted across both
// metrics.
const recordAuthEvent = (
  event: "signup" | "login" | "refresh",
  outcome: "success" | "failure",
) =>
  Metric.update(
    Metric.taggedWithLabels(authEventsTotal, [
      MetricLabel.make("event", event),
      MetricLabel.make("outcome", outcome),
    ]),
    1,
  );

// Rotation info for a refresh: the row being replaced, identified by its own
// jti plus the familyId it belongs to (every token descended from the same
// login shares one, so the whole chain can be revoked at once on reuse).
type Rotating = { readonly oldJti: string; readonly familyId: string };

// Issues a refresh token for `user` and persists its jti so `POST
// /users/refresh` can later look it up — a refresh token is only honored
// while its row is present and unrevoked. A fresh login starts a new
// family. On rotation, the old row is marked revoked (not deleted) and the
// new row joins the same family, in one transaction, so the previous
// refresh token stops working at the same instant the new one starts, while
// still being available for reuse detection later.
const issueRefreshToken = (
  db: DrizzleDb,
  jwt: Context.Tag.Service<typeof Jwt>,
  user: TokenUser,
  rotating?: Rotating,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const { token, jti, expiresAt } = yield* jwt.signRefreshToken(user);
    const familyId = rotating?.familyId ?? crypto.randomUUID();
    yield* Effect.tryPromise(() =>
      rotating
        ? db.transaction(async (tx) => {
            await tx
              .update(refreshTokens)
              .set({ revokedAt: new Date() })
              .where(eq(refreshTokens.jti, rotating.oldJti));
            await tx
              .insert(refreshTokens)
              .values({ jti, userId: user.id, familyId, expiresAt });
          })
        : db
            .insert(refreshTokens)
            .values({ jti, userId: user.id, familyId, expiresAt }),
    ).pipe(Effect.orDie);
    return token;
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
  (handlers) =>
    handlers
      .handle("searchUsers", ({ urlParams: { q } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const pattern = `%${escapeLikePattern(q)}%`;
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmall: users.avatarSmall,
                avatarMedium: users.avatarMedium,
                avatarLarge: users.avatarLarge,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
              })
              .from(users)
              .where(ilike(users.username, pattern))
              .orderBy(users.username)
              .limit(USER_SEARCH_RESULTS_LIMIT),
          ).pipe(Effect.orDie);
          return rows.map(toPublicUser);
        }),
      )
      .handle("getUser", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmall: users.avatarSmall,
                avatarMedium: users.avatarMedium,
                avatarLarge: users.avatarLarge,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
              })
              .from(users)
              .where(eq(users.id, id))
              .limit(1),
          ).pipe(Effect.orDie);
          if (!rows[0])
            return yield* Effect.fail(
              new NotFound({ message: `User ${id} not found` }),
            );
          return toPublicUser(rows[0]);
        }),
      )
      .handle("register", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const limiter = yield* RateLimiter;
          const ip = yield* clientIp;
          yield* enforceRateLimit(
            limiter,
            `register:ip:${ip}`,
            REGISTER_MAX_ATTEMPTS_PER_IP,
            REGISTER_WINDOW_SECONDS,
          );

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
          if (existing[0]) {
            yield* recordAuthEvent("signup", "failure");
            return yield* Effect.fail(
              new UsernameTaken({
                message: `Username "${payload.username}" is already taken`,
              }),
            );
          }

          const passwordHash = yield* hashPassword(payload.password);

          const rows = yield* Effect.tryPromise(() =>
            db
              .insert(users)
              // Registration always creates a "user" — admins are promoted
              // out-of-band, never via this endpoint.
              .values({
                username: payload.username,
                passwordHash,
                role: "user",
              })
              .returning({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmall: users.avatarSmall,
                avatarMedium: users.avatarMedium,
                avatarLarge: users.avatarLarge,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
              }),
          ).pipe(Effect.orDie);
          if (!rows[0])
            return yield* Effect.die(new Error("INSERT returned no rows"));
          yield* recordAuthEvent("signup", "success");
          yield* FiberRef.set(currentLogUser, rows[0].username);
          return toPublicUser(rows[0]);
        }),
      )
      .handle("login", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const jwt = yield* Jwt;
          const limiter = yield* RateLimiter;
          const ip = yield* clientIp;
          yield* enforceRateLimit(
            limiter,
            `login:ip:${ip}`,
            LOGIN_MAX_ATTEMPTS_PER_IP,
            LOGIN_WINDOW_SECONDS,
          );
          yield* enforceRateLimit(
            limiter,
            `login:account:${payload.username.toLowerCase()}`,
            LOGIN_MAX_ATTEMPTS_PER_ACCOUNT,
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
          // missing — so timing doesn't reveal whether the username exists.
          const user = rows[0];
          const hash = user ? user.passwordHash : yield* dummyHash();
          const valid = yield* verifyPassword(payload.password, hash);
          if (!user || !valid) {
            yield* recordAuthEvent("login", "failure");
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid username or password",
              }),
            );
          }

          const publicUser = toPublicUser(user);
          const tokenUser = {
            id: user.id,
            username: user.username,
            role: user.role,
            tokenVersion: user.tokenVersion,
          };
          const accessToken = yield* jwt.signAccessToken(tokenUser);
          const refreshToken = yield* issueRefreshToken(db, jwt, tokenUser);
          yield* recordAuthEvent("login", "success");
          yield* FiberRef.set(currentLogUser, user.username);
          return { user: publicUser, accessToken, refreshToken };
        }),
      )
      .handle("refresh", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const jwt = yield* Jwt;
          const limiter = yield* RateLimiter;
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
          const refreshToken = yield* issueRefreshToken(db, jwt, newTokenUser, {
            oldJti: tokenUser.jti,
            familyId: storedToken.familyId,
          });
          yield* recordAuthEvent("refresh", "success");
          return { accessToken, refreshToken };
        }),
      )
      .handle("logout", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const jwt = yield* Jwt;
          const tokenVersionCache = yield* TokenVersionCache;
          const pubsub = yield* PubSub;

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

          yield* tokenVersionCache.invalidate(tokenUser.id);
          yield* pubsub
            .publish("auth:invalidation", String(tokenUser.id))
            .pipe(Effect.ignore);
        }),
      )
      .handle("changePassword", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const jwt = yield* Jwt;
          const limiter = yield* RateLimiter;
          const currentUser = yield* CurrentUser;
          const tokenVersionCache = yield* TokenVersionCache;
          const pubsub = yield* PubSub;

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
          const valid =
            dbUser &&
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

          yield* tokenVersionCache.invalidate(currentUser.id);
          yield* pubsub
            .publish("auth:invalidation", String(currentUser.id))
            .pipe(Effect.ignore);

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
          const db = yield* Db;
          const currentUser = yield* CurrentUser;

          // Full-replace (see UpdateProfileBody's comment in Api.ts) also
          // clears any uploaded avatar — `avatarUrl` and the uploaded
          // avatarSmall/Medium/Large columns are mutually exclusive, so a
          // caller explicitly setting (or clearing) `avatarUrl` here always
          // means "stop using the uploaded one". `uploadAvatar` below is the
          // inverse.
          const rows = yield* Effect.tryPromise(() =>
            db
              .update(users)
              .set({
                displayName: payload.displayName,
                avatarUrl: payload.avatarUrl,
                avatarSmall: null,
                avatarMedium: null,
                avatarLarge: null,
              })
              .where(eq(users.id, currentUser.id))
              .returning({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmall: users.avatarSmall,
                avatarMedium: users.avatarMedium,
                avatarLarge: users.avatarLarge,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
              }),
          ).pipe(Effect.orDie);
          const updated = rows[0];
          if (!updated)
            return yield* Effect.die(new Error("UPDATE returned no rows"));
          return toPublicUser(updated);
        }),
      )
      .handle("uploadAvatar", ({ payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const db = yield* Db;
          const limiter = yield* RateLimiter;

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
          });

          const toDataUrl = (bytes: Uint8Array) =>
            `data:${processed.contentType};base64,${Buffer.from(bytes).toString("base64")}`;

          const rows = yield* Effect.tryPromise(() =>
            db
              .update(users)
              .set({
                avatarUrl: null,
                avatarSmall: toDataUrl(processed.small),
                avatarMedium: toDataUrl(processed.medium),
                avatarLarge: toDataUrl(processed.large),
              })
              .where(eq(users.id, currentUser.id))
              .returning({
                id: users.id,
                username: users.username,
                displayName: users.displayName,
                avatarUrl: users.avatarUrl,
                avatarSmall: users.avatarSmall,
                avatarMedium: users.avatarMedium,
                avatarLarge: users.avatarLarge,
                role: users.role,
                statusText: users.statusText,
                statusEmoji: users.statusEmoji,
                statusExpiresAt: users.statusExpiresAt,
              }),
          ).pipe(Effect.orDie);
          const updated = rows[0];
          if (!updated)
            return yield* Effect.die(new Error("UPDATE returned no rows"));
          return toPublicUser(updated);
        }),
      )
      .handle("deleteAccount", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const limiter = yield* RateLimiter;
          const currentUser = yield* CurrentUser;
          const tokenVersionCache = yield* TokenVersionCache;
          const pubsub = yield* PubSub;

          yield* enforceRateLimit(
            limiter,
            `delete-account:account:${currentUser.id}`,
            DELETE_ACCOUNT_MAX_ATTEMPTS_PER_ACCOUNT,
            DELETE_ACCOUNT_WINDOW_SECONDS,
          );

          const rows = yield* Effect.tryPromise(() =>
            db
              .select({ passwordHash: users.passwordHash })
              .from(users)
              .where(eq(users.id, currentUser.id))
              .limit(1),
          ).pipe(Effect.orDie);
          const dbUser = rows[0];
          const valid =
            dbUser &&
            (yield* verifyPassword(payload.password, dbUser.passwordHash));
          if (!valid)
            return yield* Effect.fail(
              new InvalidCredentials({ message: "Incorrect password" }),
            );

          // The `users` row's cascading/`set null` FKs (db/schema.ts) take
          // care of everything else this account owns — refresh tokens,
          // posts, comments, likes, chat participation, sent messages, read
          // receipts.
          yield* Effect.tryPromise(() =>
            db.delete(users).where(eq(users.id, currentUser.id)),
          ).pipe(Effect.orDie);

          yield* tokenVersionCache.invalidate(currentUser.id);
          yield* pubsub
            .publish("auth:invalidation", String(currentUser.id))
            .pipe(Effect.ignore);
        }),
      )
      .handle("updateUserRole", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const tokenVersionCache = yield* TokenVersionCache;
          const pubsub = yield* PubSub;

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
                avatarSmall: users.avatarSmall,
                avatarMedium: users.avatarMedium,
                avatarLarge: users.avatarLarge,
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

          yield* tokenVersionCache.invalidate(id);
          yield* pubsub
            .publish("auth:invalidation", String(id))
            .pipe(Effect.ignore);

          return toPublicUser(updated);
        }),
      )
      .handle("updateStatus", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;

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
                avatarSmall: users.avatarSmall,
                avatarMedium: users.avatarMedium,
                avatarLarge: users.avatarLarge,
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
          yield* connections.broadcastAll({
            type: "status_changed",
            userId: currentUser.id,
            statusText: publicUser.statusText,
            statusEmoji: publicUser.statusEmoji,
            statusExpiresAt: publicUser.statusExpiresAt,
          });
          return publicUser;
        }),
      ),
);
