import { and, eq, isNull, sql } from "drizzle-orm";
import { Cache, Effect, Metric } from "effect";
import { setLogUser } from "../RedactedLogger.ts";
import { InvalidCredentials, UsernameTaken } from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import { type DrizzleDb } from "../Db.ts";
import { Jwt, type TokenUser } from "../Jwt.ts";
import { authEventsTotal } from "../Metrics.ts";
import { clientIp } from "../ClientIp.ts";
import { refreshTokens, users } from "../db/schema.ts";
import { type UsersDeps, type UsersHandlers } from "./handlerKit.ts";
import { enforceRateLimit } from "../RateLimiter.ts";
import { dummyHash, hashPassword, verifyPassword } from "./credentials.ts";
import { toPublicUser } from "./userViews.ts";

// Sensible defaults for auth-endpoint rate limiting (see issue #25). Login is
// capped per source IP and per targeted account, but every one of those
// buckets effectively counts only *failed* attempts (issues #480, #767): each
// attempt consumes them up front, so concurrent guesses can't race past the
// limit (issue #543), and a successful login then hands its unit back. That
// matters most for the IP bucket — everyone behind one public address (a
// school, an office, a carrier's CGNAT, a VPN) shares it, so counting
// successes there turned a busy network's 21st sign-in into a 429. On
// success the account+IP bucket is cleared outright, while the IP and
// account-wide buckets are only refunded one unit: wiping them would erase
// an attacker's tally whenever someone signs in. The tight account bucket is
// also keyed by IP, so an attacker hammering wrong passwords for someone's
// username only locks *themselves* out of that account; the looser
// account-wide ceiling still bounds how many guesses a distributed attacker
// (many IPs) gets per window, and the per-IP ceiling bounds one address
// spraying guesses across many usernames.
const LOGIN_MAX_FAILURES_PER_IP = 50;

const LOGIN_MAX_FAILURES_PER_ACCOUNT_AND_IP = 5;

const LOGIN_MAX_FAILURES_PER_ACCOUNT = 50;

const LOGIN_WINDOW_SECONDS = 15 * 60;

// Registration has no natural "account" bucket (that's what's being
// created), so it's capped per IP only — by an hourly ceiling roomy enough
// for a class or team onboarding together behind one address (issue #767),
// plus a short burst limit so a script can't create accounts back to back.
const REGISTER_MAX_ATTEMPTS_PER_IP = 50;

const REGISTER_WINDOW_SECONDS = 60 * 60;

const REGISTER_BURST_MAX_ATTEMPTS_PER_IP = 10;

const REGISTER_BURST_WINDOW_SECONDS = 60;

// Refreshing is routine/automatic (a client does it roughly once per access
// token lifetime), so its limit is looser than login's — it exists mainly as
// a ceiling against refresh-token guessing, not to constrain normal use.
const REFRESH_MAX_ATTEMPTS_PER_IP = 60;

const REFRESH_WINDOW_SECONDS = 15 * 60;

// Bounds how many current-password guesses a caller (who must already hold a
// valid access token) can make before being locked out — mirrors login's
// per-account bucket, keyed by user id rather than username.
const CHANGE_PASSWORD_MAX_ATTEMPTS_PER_ACCOUNT = 5;

const CHANGE_PASSWORD_WINDOW_SECONDS = 15 * 60;

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

export const authHandlers = ({
  db,
  limiter,
  connections,
  pubsub,
  jwt,
  tokenVersionCache,
}: UsersDeps) =>
  ({
    register: ({ payload }) =>
      Effect.gen(function* () {
        const ip = yield* clientIp;
        yield* enforceRateLimit(
          limiter,
          `register:ip-burst:${ip}`,
          REGISTER_BURST_MAX_ATTEMPTS_PER_IP,
          REGISTER_BURST_WINDOW_SECONDS,
        );
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
              eq(sql`lower(${users.username})`, payload.username.toLowerCase()),
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
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
              role: users.role,
              statusText: users.statusText,
              statusEmoji: users.statusEmoji,
              statusExpiresAt: users.statusExpiresAt,
            }),
        ).pipe(Effect.orDie);
        if (!rows[0])
          return yield* Effect.die(new Error("INSERT returned no rows"));
        yield* recordAuthEvent("signup", "success");
        yield* setLogUser(rows[0].username);
        return toPublicUser(rows[0]);
      }),
    login: ({ payload }) =>
      Effect.gen(function* () {
        const ip = yield* clientIp;
        const ipKey = `login:ip:${ip}`;
        yield* enforceRateLimit(
          limiter,
          ipKey,
          LOGIN_MAX_FAILURES_PER_IP,
          LOGIN_WINDOW_SECONDS,
        );
        const account = payload.username.toLowerCase();
        const accountIpKey = `login:account-ip:${account}:${ip}`;
        const accountKey = `login:account:${account}`;
        // The IP bucket above and both account buckets are consumed
        // atomically *before* the (slow, async) password check — a
        // check-then-consume would let concurrent guesses all pass the
        // check before any of them counted (issue #543). A success hands
        // its units back below.
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
              eq(sql`lower(${users.username})`, payload.username.toLowerCase()),
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

        // Success: forgive this IP's failures against the account, but
        // only refund this one attempt on the IP and account-wide buckets —
        // wiping them would erase an attacker's tally whenever someone
        // signs in (from their network, or to the targeted account).
        yield* limiter.reset(accountIpKey);
        yield* limiter.refund(accountKey);
        yield* limiter.refund(ipKey);

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
        yield* setLogUser(user.username);
        return { user: publicUser, accessToken, refreshToken };
      }),
    refresh: ({ payload }) =>
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
    logout: ({ payload }) =>
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
    changePassword: ({ payload }) =>
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
        const valid =
          dbUser &&
          (yield* verifyPassword(payload.currentPassword, dbUser.passwordHash));
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
  }) satisfies UsersHandlers;
