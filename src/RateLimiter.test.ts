import { expect, test } from "bun:test";
import { Effect } from "effect";
import { InMemoryRateLimiterLive, RateLimiter } from "./RateLimiter.ts";

const run = <A>(effect: Effect.Effect<A, never, RateLimiter>) =>
  Effect.runPromise(Effect.provide(effect, InMemoryRateLimiterLive));

test("peek reports the bucket's state without counting the call", () =>
  run(
    Effect.gen(function* () {
      const limiter = yield* RateLimiter;
      expect((yield* limiter.peek("k", 2)).allowed).toBe(true);
      yield* limiter.consume("k", 2, 60);
      // Peeking repeatedly never fills the bucket by itself.
      for (let i = 0; i < 5; i++) {
        expect((yield* limiter.peek("k", 2)).allowed).toBe(true);
      }
      yield* limiter.consume("k", 2, 60);
      const full = yield* limiter.peek("k", 2);
      expect(full.allowed).toBe(false);
      expect(full.retryAfterSeconds).toBeGreaterThan(0);
    }),
  ));

test("reset empties a bucket", () =>
  run(
    Effect.gen(function* () {
      const limiter = yield* RateLimiter;
      yield* limiter.consume("k", 1, 60);
      expect((yield* limiter.consume("k", 1, 60)).allowed).toBe(false);
      yield* limiter.reset("k");
      expect((yield* limiter.consume("k", 1, 60)).allowed).toBe(true);
    }),
  ));
