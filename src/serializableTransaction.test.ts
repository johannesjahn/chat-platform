import { describe, expect, test } from "bun:test";
import { Effect, Exit, Metric } from "effect";
import type { DrizzleDb } from "./Db.ts";
import { dbQueryDurationSeconds, dbQueryErrorsTotal } from "./Metrics.ts";
import {
  isRetryableAbort,
  SERIALIZABLE_MAX_RETRIES,
  serializableTransaction,
} from "./serializableTransaction.ts";

// Shaped like Bun.sql's PostgresError: SQLSTATE in `errno`, wrapped the way
// drizzle wraps driver errors ("Failed query", original as `cause`).
const bunSerializationFailure = () =>
  new Error("Failed query: insert into ...", {
    cause: Object.assign(
      new Error(
        "could not serialize access due to read/write dependencies among transactions",
      ),
      {
        name: "PostgresError",
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "40001",
      },
    ),
  });

// A db whose transaction() fails with `errors` in turn, then succeeds.
const fakeDb = (errors: ReadonlyArray<unknown>) => {
  const calls: Array<unknown> = [];
  const db = {
    transaction: async (
      run: (tx: unknown) => Promise<unknown>,
      config: unknown,
    ) => {
      calls.push(config);
      const error = errors[calls.length - 1];
      if (error !== undefined) throw error;
      return run({});
    },
  } as unknown as DrizzleDb;
  return { db, calls };
};

// Module-level metrics, shared with other test files in the same worker,
// so the tests below assert deltas.
const dbMetrics = () =>
  Effect.runSync(
    Effect.all({
      aborted: Metric.value(
        Metric.withAttributes(dbQueryDurationSeconds, { outcome: "aborted" }),
      ).pipe(Effect.map((state) => state.count)),
      success: Metric.value(
        Metric.withAttributes(dbQueryDurationSeconds, { outcome: "success" }),
      ).pipe(Effect.map((state) => state.count)),
      errors: Metric.value(dbQueryErrorsTotal).pipe(
        Effect.map((state) => state.count),
      ),
    }),
  );

describe("isRetryableAbort", () => {
  test("finds the SQLSTATE through wrapping, in either field", () => {
    expect(isRetryableAbort(bunSerializationFailure())).toBe(true);
    // PGlite's DatabaseError carries it in `code`.
    expect(
      isRetryableAbort(Object.assign(new Error(), { code: "40001" })),
    ).toBe(true);
  });

  test("treats a deadlock as retryable too", () => {
    expect(
      isRetryableAbort(Object.assign(new Error(), { errno: "40P01" })),
    ).toBe(true);
    expect(
      isRetryableAbort(Object.assign(new Error(), { code: "40P01" })),
    ).toBe(true);
  });

  test("rejects other errors", () => {
    for (const error of [
      new Error("boom"),
      Object.assign(new Error(), { code: "23505" }),
      Object.assign(new Error(), { errno: "40P02" }),
      "40001",
      null,
      undefined,
    ])
      expect(isRetryableAbort(error)).toBe(false);
  });
});

describe("serializableTransaction", () => {
  test("runs at serializable isolation", async () => {
    const { db, calls } = fakeDb([]);
    const result = await Effect.runPromise(
      serializableTransaction(db, async () => "done"),
    );
    expect(result).toBe("done");
    expect(calls).toEqual([{ isolationLevel: "serializable" }]);
  });

  test("retries serialization failures until the transaction commits", async () => {
    const { db, calls } = fakeDb([
      bunSerializationFailure(),
      bunSerializationFailure(),
    ]);
    const result = await Effect.runPromise(
      serializableTransaction(db, async () => 42),
    );
    expect(result).toBe(42);
    expect(calls).toHaveLength(3);
  });

  test("gives up after the retry budget and dies", async () => {
    const { db, calls } = fakeDb(
      Array.from({ length: SERIALIZABLE_MAX_RETRIES + 5 }, () =>
        bunSerializationFailure(),
      ),
    );
    const exit = await Effect.runPromiseExit(
      serializableTransaction(db, async () => 42),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    expect(calls).toHaveLength(SERIALIZABLE_MAX_RETRIES + 1);
  });

  test("never retries other errors", async () => {
    const { db, calls } = fakeDb([new Error("connection reset")]);
    const exit = await Effect.runPromiseExit(
      serializableTransaction(db, async () => 42),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("times each attempt, a retried abort as aborted, without counting an error", async () => {
    const { db } = fakeDb([
      bunSerializationFailure(),
      bunSerializationFailure(),
    ]);
    const before = dbMetrics();
    await Effect.runPromise(serializableTransaction(db, async () => 42));
    const after = dbMetrics();
    expect(after.aborted).toBe(before.aborted + 2);
    expect(after.success).toBe(before.success + 1);
    expect(after.errors).toBe(before.errors);
  });

  test("counts an abort that outlasts the retries as one error", async () => {
    const { db } = fakeDb(
      Array.from({ length: SERIALIZABLE_MAX_RETRIES + 5 }, () =>
        bunSerializationFailure(),
      ),
    );
    const before = dbMetrics();
    await Effect.runPromiseExit(serializableTransaction(db, async () => 42));
    const after = dbMetrics();
    expect(after.aborted).toBe(before.aborted + SERIALIZABLE_MAX_RETRIES + 1);
    expect(after.errors).toBe(before.errors + 1);
  });

  test("counts any other failure as one error", async () => {
    const { db } = fakeDb([new Error("connection reset")]);
    const before = dbMetrics();
    await Effect.runPromiseExit(serializableTransaction(db, async () => 42));
    expect(dbMetrics().errors).toBe(before.errors + 1);
  });
});
