import { afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { DrizzleDb } from "./Db.ts";
import * as schema from "./db/schema.ts";

const createTestDb = async () => {
  const db = drizzle({ schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db;
};

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

// Booting a fresh PGlite instance and replaying every migration costs
// ~600-900ms — see bunfig.toml's raised test timeout. Each test file that
// calls `makeTestDbAccessor()` gets one instance shared across all of its
// own tests (paying that cost once per file instead of once per test), with
// `resetTestDb` (a plain TRUNCATE, ~5ms) restoring a clean slate between
// tests so they stay as isolated as if each had gotten a brand new
// database.
//
// This is deliberately scoped *per file*, not shared process-wide across
// the whole `bun test ./src` run: a single PGlite instance still open when
// RealtimeSocket.integration.test.ts's spawned child process and
// RealtimePubSub.integration.test.ts's real Redis connections are torn down
// has been observed to crash the whole `bun test` process on exit (code 99,
// no test failures — a native-level crash in Bun's WASM runtime, not a bug
// in any test). `afterAll` is registered here, inside the accessor itself,
// rather than left for each call site to remember — so every instance is
// guaranteed dead well before later files run.
export const makeTestDbAccessor = () => {
  let dbPromise: Promise<TestDb> | undefined;

  const getTestDb = (): Promise<TestDb> => {
    dbPromise ??= createTestDb();
    return dbPromise;
  };

  afterAll(async () => {
    if (!dbPromise) return;
    const db = await dbPromise;
    await db.$client.close();
  });

  return { getTestDb };
};

// Derived from the schema (rather than hand-listed) so a table added to
// db/schema.ts is truncated automatically — an omission here wouldn't fail
// loudly, it would just leak rows across tests in the same file. Order
// doesn't matter: TRUNCATE ... CASCADE handles foreign key dependencies
// itself.
const TABLE_NAMES = Object.values(schema).map(
  (table) => getTableConfig(table).name,
);

export const resetTestDb = async (db: DrizzleDb): Promise<void> => {
  await db.execute(
    sql.raw(
      `TRUNCATE TABLE ${TABLE_NAMES.join(", ")} RESTART IDENTITY CASCADE`,
    ),
  );
};
