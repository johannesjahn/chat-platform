import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import type { DrizzleDb } from "./Db.ts";
import {
  isSerializationFailure,
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

describe("isSerializationFailure", () => {
  test("finds the SQLSTATE through wrapping, in either field", () => {
    expect(isSerializationFailure(bunSerializationFailure())).toBe(true);
    // PGlite's DatabaseError carries it in `code`.
    expect(
      isSerializationFailure(Object.assign(new Error(), { code: "40001" })),
    ).toBe(true);
  });

  test("rejects other errors", () => {
    for (const error of [
      new Error("boom"),
      Object.assign(new Error(), { code: "23505" }),
      Object.assign(new Error(), { errno: "40P01" }),
      "40001",
      null,
      undefined,
    ])
      expect(isSerializationFailure(error)).toBe(false);
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
});
