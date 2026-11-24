import { expect, test } from "bun:test";
import { Duration, Effect, Layer, Metric } from "effect";
import { activeUsersTick } from "./ActiveUsersMetrics.ts";
import { Db } from "./Db.ts";
import { activeUsers } from "./Metrics.ts";
import {
  claimJobRun,
  readJobResult,
  recordJobResult,
  runIfClaimed,
} from "./scheduledJobs.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";
import { posts, scheduledJobs, users } from "./db/schema.ts";

const { getTestDb } = makeTestDbAccessor();

const run = <A, E>(effect: Effect.Effect<A, E, Db>): Promise<A> => {
  const TestDbLive = Layer.effect(
    Db,
    Effect.promise(async () => {
      const db = await getTestDb();
      await resetTestDb(db);
      return db;
    }),
  );
  return Effect.runPromise(effect.pipe(Effect.provide(TestDbLive)));
};

const HOUR = Duration.hours(1);

test("of several replicas claiming the same job at once, exactly one wins (issue #831)", () =>
  run(
    Effect.gen(function* () {
      const claims = yield* Effect.all(
        Array.from({ length: 5 }, () => claimJobRun("job", HOUR)),
        { concurrency: "unbounded" },
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
    }),
  ));

test("a job isn't claimed again until its interval has passed", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      expect(yield* claimJobRun("job", HOUR)).toBe(true);
      expect(yield* claimJobRun("job", HOUR)).toBe(false);

      // As if the last run was 61 minutes ago.
      yield* Effect.promise(() =>
        db
          .update(scheduledJobs)
          .set({ lastRunAt: new Date(Date.now() - 61 * 60_000) }),
      );
      expect(yield* claimJobRun("job", HOUR)).toBe(true);
      expect(yield* claimJobRun("job", HOUR)).toBe(false);
    }),
  ));

test("jobs are claimed independently of each other", () =>
  run(
    Effect.gen(function* () {
      expect(yield* claimJobRun("a", HOUR)).toBe(true);
      expect(yield* claimJobRun("b", HOUR)).toBe(true);
    }),
  ));

test("runIfClaimed runs the job only on the replica that claims it", () =>
  run(
    Effect.gen(function* () {
      let runs = 0;
      const job = Effect.sync(() => {
        runs++;
      });
      yield* Effect.all(
        Array.from({ length: 4 }, () => runIfClaimed("job", HOUR, job)),
        { concurrency: "unbounded" },
      );
      expect(runs).toBe(1);
    }),
  ));

test("a stored result is readable by every replica", () =>
  run(
    Effect.gen(function* () {
      expect(yield* readJobResult("job")).toBeUndefined();
      yield* claimJobRun("job", HOUR);
      yield* recordJobResult("job", { "1d": 3 });
      expect(yield* readJobResult("job")).toEqual({ "1d": 3 });
    }),
  ));

test("a replica that doesn't win the active-users run still reports the counts the winner stored", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const [author] = yield* Effect.promise(() =>
        db
          .insert(users)
          .values({ username: "poster", passwordHash: "x" })
          .returning(),
      );
      yield* Effect.promise(() =>
        db.insert(posts).values({
          authorId: author!.id,
          body: "hi",
        }),
      );

      // The winner scans and stores; reset the gauge as if this were another
      // process that never scanned.
      yield* activeUsersTick;
      yield* Metric.update(
        Metric.withAttributes(activeUsers, { window: "1d" }),
        0,
      );
      // This tick loses the claim (the interval hasn't passed), so it can only
      // have the count from the stored result.
      yield* activeUsersTick;
      const gauge = yield* Metric.value(
        Metric.withAttributes(activeUsers, { window: "1d" }),
      );
      expect(gauge.value).toBe(1);
    }),
  ));
