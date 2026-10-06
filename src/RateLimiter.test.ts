import { RedisClient } from "bun";
import { expect, test } from "bun:test";
import { Effect, type Layer } from "effect";
import {
  InMemoryRateLimiterLive,
  RateLimiter,
  RedisRateLimiterLive,
} from "./RateLimiter.ts";

// The Redis variants need a real Redis at REDIS_URL (docker-compose's `redis`
// service, or CI — see .github/workflows/ci.yml) and are skipped otherwise,
// like RealtimePubSub.integration.test.ts.
const redisConfigured = Boolean(process.env.REDIS_URL);

const implementations: ReadonlyArray<{
  readonly name: string;
  readonly layer: Layer.Layer<RateLimiter>;
  readonly enabled: boolean;
}> = [
  { name: "in-memory", layer: InMemoryRateLimiterLive, enabled: true },
  { name: "redis", layer: RedisRateLimiterLive, enabled: redisConfigured },
];

for (const { name, layer, enabled } of implementations) {
  const run = <A>(effect: Effect.Effect<A, never, RateLimiter>) =>
    Effect.runPromise(Effect.provide(effect, layer));
  // Redis state outlives a test run, so each test gets its own bucket.
  const freshKey = () => `test:${crypto.randomUUID()}`;
  const it = enabled ? test : test.skip;

  it(`[${name}] reset empties a bucket`, () =>
    run(
      Effect.gen(function* () {
        const limiter = yield* RateLimiter;
        const k = freshKey();
        yield* limiter.consume(k, 1, 60);
        expect((yield* limiter.consume(k, 1, 60)).allowed).toBe(false);
        yield* limiter.reset(k);
        expect((yield* limiter.consume(k, 1, 60)).allowed).toBe(true);
      }),
    ));

  it(`[${name}] refund gives back exactly one consumed unit`, () =>
    run(
      Effect.gen(function* () {
        const limiter = yield* RateLimiter;
        const k = freshKey();
        yield* limiter.consume(k, 2, 60);
        yield* limiter.consume(k, 2, 60);
        expect((yield* limiter.consume(k, 2, 60)).allowed).toBe(false);
        // The bucket now holds 3 (the rejected call counted too): two
        // refunds bring it back to 1, leaving room for exactly one more.
        yield* limiter.refund(k);
        yield* limiter.refund(k);
        expect((yield* limiter.consume(k, 2, 60)).allowed).toBe(true);
        expect((yield* limiter.consume(k, 2, 60)).allowed).toBe(false);
      }),
    ));

  it(`[${name}] refund never takes a bucket below zero`, () =>
    run(
      Effect.gen(function* () {
        const limiter = yield* RateLimiter;
        const k = freshKey();
        // Refunding a bucket that was never consumed is a no-op...
        yield* limiter.refund(k);
        yield* limiter.consume(k, 1, 60);
        // ...and over-refunding one only empties it — no banked credit.
        for (let i = 0; i < 5; i++) yield* limiter.refund(k);
        expect((yield* limiter.consume(k, 1, 60)).allowed).toBe(true);
        expect((yield* limiter.consume(k, 1, 60)).allowed).toBe(false);
      }),
    ));

  it(`[${name}] refund keeps the bucket's window`, () =>
    run(
      Effect.gen(function* () {
        const limiter = yield* RateLimiter;
        const k = freshKey();
        const first = yield* limiter.consume(k, 5, 60);
        yield* limiter.refund(k);
        const next = yield* limiter.consume(k, 5, 60);
        // Still the same window (not restarted, not made permanent).
        expect(next.retryAfterSeconds).toBeGreaterThan(0);
        expect(next.retryAfterSeconds).toBeLessThanOrEqual(
          first.retryAfterSeconds,
        );
      }),
    ));
}

(redisConfigured ? test : test.skip)(
  "[redis] refund neither strips the TTL nor recreates a missing key",
  async () => {
    const admin = new RedisClient(process.env.REDIS_URL);
    try {
      const k = `test:${crypto.randomUUID()}`;
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const limiter = yield* RateLimiter;
            yield* limiter.consume(k, 5, 60);
            yield* limiter.consume(k, 5, 60);
            yield* limiter.refund(k);
          }),
          RedisRateLimiterLive,
        ),
      );
      expect(await admin.get(`ratelimit:${k}`)).toBe("1");
      const ttl = await admin.ttl(`ratelimit:${k}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);

      const missing = `test:${crypto.randomUUID()}`;
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const limiter = yield* RateLimiter;
            yield* limiter.refund(missing);
          }),
          RedisRateLimiterLive,
        ),
      );
      expect(await admin.exists(`ratelimit:${missing}`)).toBe(false);
    } finally {
      admin.close();
    }
  },
);
