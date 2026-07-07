import { HttpApiBuilder } from "@effect/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Context, Effect } from "effect";
import { ChatApi, InvalidCredentials, NotFound, UsernameTaken } from "./Api.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { Jwt, type TokenUser } from "./Jwt.ts";
import { refreshTokens, users } from "./db/schema.ts";

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
      .handle("listUsers", () =>
        Effect.gen(function* () {
          const db = yield* Db;
          return yield* Effect.tryPromise(() =>
            db
              .select({
                id: users.id,
                username: users.username,
                role: users.role,
              })
              .from(users)
              .orderBy(users.id),
          ).pipe(Effect.orDie);
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
                role: users.role,
              })
              .from(users)
              .where(eq(users.id, id))
              .limit(1),
          ).pipe(Effect.orDie);
          if (!rows[0])
            return yield* Effect.fail(
              new NotFound({ message: `User ${id} not found` }),
            );
          return rows[0];
        }),
      )
      .handle("register", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;

          const existing = yield* Effect.tryPromise(() =>
            db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.username, payload.username))
              .limit(1),
          ).pipe(Effect.orDie);
          if (existing[0])
            return yield* Effect.fail(
              new UsernameTaken({
                message: `Username "${payload.username}" is already taken`,
              }),
            );

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
                role: users.role,
              }),
          ).pipe(Effect.orDie);
          if (!rows[0])
            return yield* Effect.die(new Error("INSERT returned no rows"));
          return rows[0];
        }),
      )
      .handle("login", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const jwt = yield* Jwt;
          const rows = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(users)
              .where(eq(users.username, payload.username))
              .limit(1),
          ).pipe(Effect.orDie);

          // Always run a verify — against a dummy hash when the user is
          // missing — so timing doesn't reveal whether the username exists.
          const user = rows[0];
          const hash = user ? user.passwordHash : yield* dummyHash();
          const valid = yield* verifyPassword(payload.password, hash);
          if (!user || !valid)
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid username or password",
              }),
            );

          const publicUser = {
            id: user.id,
            username: user.username,
            role: user.role,
          };
          const tokenUser = { ...publicUser, tokenVersion: user.tokenVersion };
          const accessToken = yield* jwt.signAccessToken(tokenUser);
          const refreshToken = yield* issueRefreshToken(db, jwt, tokenUser);
          return { user: publicUser, accessToken, refreshToken };
        }),
      )
      .handle("refresh", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const jwt = yield* Jwt;

          const tokenUser = yield* jwt
            .verifyRefreshToken(payload.refreshToken)
            .pipe(
              Effect.mapError(
                () =>
                  new InvalidCredentials({
                    message: "Invalid or expired refresh token",
                  }),
              ),
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
          if (!storedToken)
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid or expired refresh token",
              }),
            );

          // The row is still there but already revoked — either explicitly
          // (logout) or, most notably, by rotation: this exact token was
          // already exchanged for a newer one once before. Presenting it
          // again means someone other than whoever holds the current token
          // has a copy, i.e. it was stolen. Revoke the rest of the family
          // (including whatever it was rotated to) so the thief and the
          // legitimate holder both get logged out and have to re-authenticate.
          if (storedToken.revokedAt) {
            yield* revokeFamily(db, storedToken.familyId);
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
          if (!dbUser || dbUser.tokenVersion !== tokenUser.tokenVersion)
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid or expired refresh token",
              }),
            );

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
          return { accessToken, refreshToken };
        }),
      )
      .handle("logout", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const jwt = yield* Jwt;

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
        }),
      ),
);
