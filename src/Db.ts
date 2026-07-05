import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Context, Effect, Layer } from "effect";
import * as schema from "./db/schema.ts";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export class Db extends Context.Tag("Db")<Db, DrizzleDb>() {}

// `DB_PATH` is a data *directory* PGlite persists its Postgres files under
// (unset = in-memory, thrown away on exit), not a single file the way
// `bun:sqlite`'s path worked.
export const DbLive = Layer.effect(
  Db,
  Effect.promise(async () => {
    const client = await PGlite.create(process.env.DB_PATH);
    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
    return db;
  }),
);
