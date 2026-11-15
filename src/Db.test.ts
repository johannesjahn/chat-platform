import { expect, test } from "bun:test";
import { Effect, Exit, Metric } from "effect";
import {
  DEFAULT_DB_POOL_MAX,
  dbQuery,
  parseDbPoolMax,
  timedDbCall,
} from "./Db.ts";
import { dbQueryDurationSeconds, dbQueryErrorsTotal } from "./Metrics.ts";

// Both metrics are module-level and shared with whichever other test files
// land in the same `bun test --parallel` worker, so these assert deltas.
const callCount = (outcome: "success" | "failure" | "aborted") =>
  Effect.runSync(
    Metric.value(
      Metric.withAttributes(dbQueryDurationSeconds, { outcome }),
    ).pipe(Effect.map((state) => state.count)),
  );
const durationSum = (outcome: "success") =>
  Effect.runSync(
    Metric.value(
      Metric.withAttributes(dbQueryDurationSeconds, { outcome }),
    ).pipe(Effect.map((state) => state.sum)),
  );
const errorCount = () =>
  Effect.runSync(
    Metric.value(dbQueryErrorsTotal).pipe(Effect.map((state) => state.count)),
  );

test("dbQuery times a successful call without counting an error", async () => {
  const before = {
    success: callCount("success"),
    sum: durationSum("success"),
    errors: errorCount(),
  };
  const result = await Effect.runPromise(
    dbQuery(async () => {
      await Bun.sleep(5);
      return 42;
    }),
  );
  expect(result).toBe(42);
  expect(callCount("success")).toBe(before.success + 1);
  expect(durationSum("success") - before.sum).toBeGreaterThanOrEqual(0.004);
  expect(errorCount()).toBe(before.errors);
});

test("dbQuery times a failed call, counts it in db_query_errors_total, and dies", async () => {
  const before = { failure: callCount("failure"), errors: errorCount() };
  const exit = await Effect.runPromiseExit(
    dbQuery(() => Promise.reject(new Error("connection lost"))),
  );
  expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
  expect(callCount("failure")).toBe(before.failure + 1);
  expect(errorCount()).toBe(before.errors + 1);
});

test("timedDbCall times an expected abort as aborted, not as an error", async () => {
  const abort = new Error("rolled back on purpose");
  const before = { aborted: callCount("aborted"), errors: errorCount() };
  const exit = await Effect.runPromiseExit(
    timedDbCall(
      Effect.tryPromise({
        try: () => Promise.reject(abort),
        catch: (cause) => cause,
      }),
      (cause) => cause === abort,
    ),
  );
  // Left in the error channel for the caller to handle.
  expect(exit).toEqual(Exit.fail(abort));
  expect(callCount("aborted")).toBe(before.aborted + 1);
  expect(errorCount()).toBe(before.errors);
});

test("timedDbCall times each run of the effect it wraps on its own", async () => {
  const before = callCount("success");
  const call = timedDbCall(Effect.tryPromise(async () => "ok"));
  await Effect.runPromise(Effect.all([call, call, call]));
  expect(callCount("success")).toBe(before + 3);
});

test("DB_POOL_MAX defaults to Bun.sql's own 10 when unset or blank", () => {
  expect(parseDbPoolMax(undefined)).toBe(DEFAULT_DB_POOL_MAX);
  expect(parseDbPoolMax("")).toBe(DEFAULT_DB_POOL_MAX);
  expect(DEFAULT_DB_POOL_MAX).toBe(10);
});

test("DB_POOL_MAX takes a positive integer", () => {
  expect(parseDbPoolMax("4")).toBe(4);
  expect(parseDbPoolMax("50")).toBe(50);
});

test("DB_POOL_MAX refuses anything else rather than silently falling back", () => {
  for (const bad of ["0", "-1", "2.5", "ten", "1e2x"]) {
    expect(() => parseDbPoolMax(bad)).toThrow("DB_POOL_MAX");
  }
});
