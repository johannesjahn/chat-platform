import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
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
// in any test). Every caller must close its instance in `afterAll` — see
// `closeTestDb` — so it's dead well before later files run.
export const makeTestDbAccessor = () => {
  let dbPromise: Promise<TestDb> | undefined;

  const getTestDb = (): Promise<TestDb> => {
    dbPromise ??= createTestDb();
    return dbPromise;
  };

  const closeTestDb = async (): Promise<void> => {
    if (!dbPromise) return;
    const db = await dbPromise;
    await db.$client.close();
  };

  return { getTestDb, closeTestDb };
};

// Listed in no particular order — TRUNCATE ... CASCADE takes care of foreign
// key dependency order itself.
const TABLES = [
  "message_reads",
  "messages",
  "chat_participants",
  "chats",
  "posts",
  "refresh_tokens",
  "users",
];

export const resetTestDb = async (db: DrizzleDb): Promise<void> => {
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`),
  );
};
