import { Effect } from "effect";

// Argon2id via Bun's built-in password hashing — no external dependency.
export const hashPassword = (password: string): Effect.Effect<string> =>
  Effect.tryPromise(() =>
    Bun.password.hash(password, { algorithm: "argon2id" }),
  ).pipe(Effect.orDie);

export const verifyPassword = (
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

export const dummyHash = (): Effect.Effect<string> =>
  Effect.promise(() => dummyHashPromise);
