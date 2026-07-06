import { lt } from "drizzle-orm";
import { Duration, Effect, Layer, Schedule } from "effect";
import { Db } from "./Db.ts";
import { refreshTokens } from "./db/schema.ts";

// An expired refresh token is already rejected by Jwt.verifyRefreshToken's
// own `exp` check before UsersHandler ever consults the store — so a lapsed
// row is dead weight, not a security hole. This just reclaims it, so
// `refresh_tokens` doesn't grow without bound with rows nothing will ever
// look up again.
export const cleanupExpiredRefreshTokens: Effect.Effect<void, never, Db> =
  Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.tryPromise(() =>
      db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, new Date())),
    ).pipe(Effect.orDie);
  });

const CLEANUP_INTERVAL = Duration.hours(1);

// Runs cleanupExpiredRefreshTokens once at startup and then every
// CLEANUP_INTERVAL for as long as the layer stays built, as a background
// fiber tied to the layer's scope (interrupted on shutdown).
export const RefreshTokenCleanupLive = Layer.scopedDiscard(
  Effect.forkScoped(
    cleanupExpiredRefreshTokens.pipe(
      Effect.repeat(Schedule.spaced(CLEANUP_INTERVAL)),
    ),
  ),
);
