/**
 * Standalone database migration script.
 *
 * Usage:  bun run db:migrate
 *
 * Connects to the database (DATABASE_URL for real Postgres, PGlite fallback
 * otherwise), applies all pending Drizzle migrations from `./drizzle`, then
 * exits. Designed to run as a one-shot command — e.g. from a Kubernetes Job
 * before replica pods boot — rather than as part of the application's startup
 * sequence.
 */
import { runMigrations } from "../src/Db.ts";

console.log("[migrate] Running database migrations…");
await runMigrations();
console.log("[migrate] Migrations complete.");
process.exit(0);
