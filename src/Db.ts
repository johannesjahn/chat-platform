import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzleBunSql } from "drizzle-orm/bun-sql";
import { migrate as migrateBunSql } from "drizzle-orm/bun-sql/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";
import * as schema from "./db/schema.ts";

// The concrete driver (PGlite vs Bun.sql, see DbLive below) only differs in
// its query-result HKT — every query-building method handlers actually call
// (select/insert/update/delete/transaction/...) is declared once on the
// shared `PgDatabase` base, so typing this as the abstract base rather than
// a union of the two concrete classes avoids TypeScript trying (and failing)
// to merge each driver's overloads across a union.
export type DrizzleDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export class Db extends Context.Tag("Db")<Db, DrizzleDb>() {}

// `DATABASE_URL`, when set (e.g. by docker-compose, pointing at a real
// Postgres container), connects over the wire via Bun's native `Bun.sql`
// client. Left unset — the default for local `bun run dev`/`bun test` — this
// falls back to PGlite (an embedded Postgres), so there's no external
// service to run: `DB_PATH` is then a data *directory* PGlite persists its
// files under (unset = in-memory, thrown away on exit).
export const DbLive = Layer.effect(
  Db,
  Effect.promise(async (): Promise<DrizzleDb> => {
    if (process.env.DATABASE_URL) {
      const db = drizzleBunSql(process.env.DATABASE_URL, { schema });
      await migrateBunSql(db, { migrationsFolder: "./drizzle" });
      return db;
    }
    const client = await PGlite.create(process.env.DB_PATH);
    const db = drizzlePglite({ client, schema });
    await migratePglite(db, { migrationsFolder: "./drizzle" });
    return db;
  }),
);
