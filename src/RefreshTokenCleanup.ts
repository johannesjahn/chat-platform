import { lt } from "drizzle-orm";
import { Duration, Effect, Layer } from "effect";
import { Db, dbQuery } from "./Db.ts";
import { refreshTokens } from "./db/schema.ts";
import { forkTicker, runIfClaimed } from "./scheduledJobs.ts";

// An expired refresh token is already rejected by Jwt.verifyRefreshToken's
// own `exp` check before UsersHandler ever consults the store — so a lapsed
// row is dead weight, not a security hole. This just reclaims it, so
// `refresh_tokens` doesn't grow without bound with rows nothing will ever
// look up again.
export const cleanupExpiredRefreshTokens: Effect.Effect<void, never, Db> =
  Effect.gen(function* () {
    const db = yield* Db;
    yield* dbQuery(() =>
      db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, new Date())),
    );
  });

const CLEANUP_INTERVAL = Duration.hours(1);

// Runs cleanupExpiredRefreshTokens once every CLEANUP_INTERVAL across all
// replicas (issue #831; see scheduledJobs.ts), as a background fiber tied to
// the layer's scope (interrupted on shutdown).
export const RefreshTokenCleanupLive = Layer.effectDiscard(
  forkTicker(
    runIfClaimed(
      "refresh-token-cleanup",
      CLEANUP_INTERVAL,
      cleanupExpiredRefreshTokens,
    ),
  ),
);
