import { HttpApiBuilder } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { ChatApi, InvalidCredentials, NotFound, UsernameTaken } from "./Api.ts";
import { Db } from "./Db.ts";
import { Jwt } from "./Jwt.ts";
import { users } from "./db/schema.ts";

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
          return yield* Effect.try(() =>
            db
              .select({ id: users.id, username: users.username })
              .from(users)
              .orderBy(users.id)
              .all(),
          ).pipe(Effect.orDie);
        }),
      )
      .handle("getUser", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const rows = yield* Effect.try(() =>
            db
              .select({ id: users.id, username: users.username })
              .from(users)
              .where(eq(users.id, id))
              .limit(1)
              .all(),
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

          const existing = yield* Effect.try(() =>
            db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.username, payload.username))
              .limit(1)
              .all(),
          ).pipe(Effect.orDie);
          if (existing[0])
            return yield* Effect.fail(
              new UsernameTaken({
                message: `Username "${payload.username}" is already taken`,
              }),
            );

          const passwordHash = yield* hashPassword(payload.password);

          const rows = yield* Effect.try(() =>
            db
              .insert(users)
              .values({ username: payload.username, passwordHash })
              .returning({ id: users.id, username: users.username })
              .all(),
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
          const rows = yield* Effect.try(() =>
            db
              .select()
              .from(users)
              .where(eq(users.username, payload.username))
              .limit(1)
              .all(),
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

          const publicUser = { id: user.id, username: user.username };
          const accessToken = yield* jwt.signAccessToken(publicUser);
          const refreshToken = yield* jwt.signRefreshToken(publicUser);
          return { user: publicUser, accessToken, refreshToken };
        }),
      ),
);
