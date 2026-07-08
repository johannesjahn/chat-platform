import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DrizzleDb } from "./Db.ts";
import * as schema from "./db/schema.ts";

// Booting a fresh PGlite instance and replaying every migration costs
// ~600-900ms — see bunfig.toml's raised test timeout. `bun test ./src` runs
// every test file sequentially in a single process (no --jobs/sharding
// configured), so this module's cache is shared across every file that
// imports it: the cost is paid once for the whole suite instead of once per
// test, and `resetTestDb` (a plain TRUNCATE, ~5ms) restores a clean slate
// between tests so they stay as isolated as if each had gotten a brand new
// database.
let dbPromise: Promise<DrizzleDb> | undefined;

export const getTestDb = (): Promise<DrizzleDb> => {
  dbPromise ??= (async () => {
    const db = drizzle({ schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
    return db;
  })();
  return dbPromise;
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
