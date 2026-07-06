import { HttpApiBuilder } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Context, Effect } from "effect";
import { ChatApi, InvalidCredentials, NotFound, UsernameTaken } from "./Api.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { Jwt, type TokenUser } from "./Jwt.ts";
import { refreshTokens, users } from "./db/schema.ts";

// Issues a refresh token for `user` and persists its jti so `POST
// /users/refresh` can later look it up — a refresh token is only honored
// while its row still exists. When `replacingJti` is given (rotation), the
// old row's deletion and the new row's insertion happen in one transaction,
// so the previous refresh token stops working at the same instant the new
// one starts.
const issueRefreshToken = (
  db: DrizzleDb,
  jwt: Context.Tag.Service<typeof Jwt>,
  user: TokenUser,
  replacingJti?: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const { token, jti, expiresAt } = yield* jwt.signRefreshToken(user);
    yield* Effect.tryPromise(() =>
      replacingJti
        ? db.transaction(async (tx) => {
            await tx
              .delete(refreshTokens)
              .where(eq(refreshTokens.jti, replacingJti));
            await tx
              .insert(refreshTokens)
              .values({ jti, userId: user.id, expiresAt });
          })
        : db.insert(refreshTokens).values({ jti, userId: user.id, expiresAt }),
    ).pipe(Effect.orDie);
    return token;
  });

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
          const accessToken = yield* jwt.signAccessToken(publicUser);
          const refreshToken = yield* issueRefreshToken(db, jwt, publicUser);
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
          // signature- and expiry-valid token whose row is gone (already
          // rotated away, explicitly revoked, or never issued by this
          // server) is refused rather than trusted on claims alone.
          const stored = yield* Effect.tryPromise(() =>
            db
              .select({ jti: refreshTokens.jti })
              .from(refreshTokens)
              .where(eq(refreshTokens.jti, tokenUser.jti))
              .limit(1),
          ).pipe(Effect.orDie);
          if (!stored[0])
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid or expired refresh token",
              }),
            );

          // Re-fetch rather than trust the token's claims, so a deleted
          // account or a role change since the refresh token was issued
          // takes effect immediately instead of surviving up to its full TTL.
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: users.id,
                username: users.username,
                role: users.role,
              })
              .from(users)
              .where(eq(users.id, tokenUser.id))
              .limit(1),
          ).pipe(Effect.orDie);
          const publicUser = rows[0];
          if (!publicUser)
            return yield* Effect.fail(
              new InvalidCredentials({
                message: "Invalid or expired refresh token",
              }),
            );

          const accessToken = yield* jwt.signAccessToken(publicUser);
          const refreshToken = yield* issueRefreshToken(
            db,
            jwt,
            publicUser,
            tokenUser.jti,
          );
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
              ? db
                  .delete(refreshTokens)
                  .where(eq(refreshTokens.userId, tokenUser.id))
              : db
                  .delete(refreshTokens)
                  .where(eq(refreshTokens.jti, tokenUser.jti)),
          ).pipe(Effect.orDie);
        }),
      ),
);
