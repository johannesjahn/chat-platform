import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Context, Layer } from "effect";
import * as schema from "./db/schema.ts";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export class Db extends Context.Tag("Db")<Db, DrizzleDb>() {}

export const DbLive = Layer.sync(Db, () => {
  const sqlite = new Database(process.env.DB_PATH ?? "dev.db");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
});
