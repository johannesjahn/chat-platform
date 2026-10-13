import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import {
  makeMediaProcessingLimit,
  mediaProcessingConcurrency,
} from "./MediaProcessingLimit.ts";

describe("mediaProcessingConcurrency", () => {
  test("uses a positive integer override", () => {
    expect(mediaProcessingConcurrency("3")).toBe(3);
  });

  test("falls back to at least one permit for unset or invalid values", () => {
    for (const raw of [undefined, "", "0", "-2", "1.5", "lots"])
      expect(mediaProcessingConcurrency(raw)).toBeGreaterThanOrEqual(1);
  });
});

describe("makeMediaProcessingLimit", () => {
  test("never runs more than `permits` jobs at once", async () => {
    const limit = makeMediaProcessingLimit(2);
    let running = 0;
    let peak = 0;
    const job = limit(
      Effect.gen(function* () {
        running++;
        peak = Math.max(peak, running);
        yield* Effect.sleep("10 millis");
        running--;
      }),
    );
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 8 }, () => job),
        {
          concurrency: "unbounded",
        },
      ),
    );
    expect(peak).toBe(2);
  });

  test("a started job keeps its permit when interrupted", async () => {
    const limit = makeMediaProcessingLimit(1);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let finished = false;
        const first = yield* Effect.forkChild(
          limit(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              finished = true;
            }),
          ),
        );
        yield* Deferred.await(started);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(first));
        // The second job must wait for the first to actually finish, not
        // just for the interrupt to be requested.
        let secondSawFinished: boolean | undefined;
        const second = yield* Effect.forkChild(
          limit(
            Effect.sync(() => {
              secondSawFinished = finished;
            }),
          ),
        );
        yield* Effect.sleep("10 millis");
        expect(secondSawFinished).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupting);
        yield* Fiber.join(second);
        return secondSawFinished;
      }),
    );
    expect(result).toBe(true);
  });
});
