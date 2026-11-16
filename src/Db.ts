import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzleBunSql } from "drizzle-orm/bun-sql";
import { migrate as migrateBunSql } from "drizzle-orm/bun-sql/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { HttpRouter } from "effect/http";
import { Context, Effect, Layer, Metric, Option } from "effect";
import { dbQueryDurationSeconds, dbQueryErrorsTotal } from "./Metrics.ts";
import * as schema from "./db/schema.ts";

// The concrete driver (PGlite vs Bun.sql, see DbLive below) only differs in
// its query-result HKT — every query-building method handlers actually call
// (select/insert/update/delete/transaction/...) is declared once on the
// shared `PgDatabase` base, so typing this as the abstract base rather than
// a union of the two concrete classes avoids TypeScript trying (and failing)
// to merge each driver's overloads across a union.
export type DrizzleDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export class Db extends Context.Service<Db, DrizzleDb>()("Db") {}

// The route a database call runs for, as `method` and `route` labels on
// `db_query_duration_seconds`: the matched route's *template*
// (`/chats/:id/messages`), the same one the router reports as `http.route`,
// so the label set is bounded by the API's routes. Read from the fiber's
// context, which carries the router's `RouteContext` for everything a
// handler runs; a call outside any request (background jobs, PubSub
// deliveries, work forked off a request) is labeled "none".
const NO_ROUTE = { method: "none", route: "none" } as const;
const currentRoute = Effect.map(
  Effect.serviceOption(HttpRouter.RouteContext),
  Option.match({
    onNone: () => NO_ROUTE,
    onSome: ({ route }) => ({
      method: route.method,
      route: String(route.path),
    }),
  }),
);

// Times one database call — an Effect wrapping the promise, as built by
// `dbQuery` — into `db_query_duration_seconds`, labeled by its outcome and
// route (`currentRoute`), and counts a failure in `db_query_errors_total`
// (Metrics.ts). `isAbort` marks errors that are an expected way for the call
// to end — a serialization failure about to be retried, a transaction rolled
// back on purpose — which are timed as "aborted" and not counted as errors.
// The error stays in the error channel.
export const timedDbCall = <A, E>(
  call: Effect.Effect<A, E>,
  isAbort: (error: E) => boolean = () => false,
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const start = performance.now();
    const record = (outcome: "success" | "failure" | "aborted") =>
      Effect.flatMap(currentRoute, (route) =>
        Metric.update(
          Metric.withAttributes(dbQueryDurationSeconds, { ...route, outcome }),
          (performance.now() - start) / 1000,
        ),
      ).pipe(
        Effect.andThen(
          outcome === "failure"
            ? Metric.update(dbQueryErrorsTotal, 1)
            : Effect.void,
        ),
      );
    return call.pipe(
      Effect.tap(() => record("success")),
      Effect.tapError((error) =>
        record(isAbort(error) ? "aborted" : "failure"),
      ),
    );
  });

// Runs one database call (a query builder, a transaction, a `Promise.all` of
// them) as an Effect. A database failure is a defect, not a typed error —
// there's nothing a handler could do about it but surface a 500 — so it dies,
// exactly like the `Effect.tryPromise(...).pipe(Effect.orDie)` this replaced
// (issue #811). Timed and counted by `timedDbCall`.
export const dbQuery = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  timedDbCall(Effect.tryPromise(run)).pipe(Effect.orDie);

// PGlite ships contrib extensions as separate WASM bundles that have to be
// registered when the instance is created — `CREATE EXTENSION pg_trgm` in
// migration 0023 fails on an instance that wasn't told about it. A real
// Postgres (DATABASE_URL) needs nothing here: the extension is trusted, so
// the migration creates it on its own. Mirrored in src/testDb.ts.
export const createPglite = () =>
  PGlite.create(process.env.DB_PATH, { extensions: { pg_trgm } });

// Connections each process's Bun.sql pool may open (issue #830). Bun.sql's
// own default is 10, which was hard-coded here before; with Postgres's
// default `max_connections = 100` that capped a deployment at ~9 replicas.
// Size it so replicas × DB_POOL_MAX stays under the server's (or PgBouncer's)
// limit. A pool is also each process's ceiling on concurrent queries.
export const DEFAULT_DB_POOL_MAX = 10;
export const parseDbPoolMax = (value: string | undefined): number => {
  if (value === undefined || value.trim() === "") return DEFAULT_DB_POOL_MAX;
  const max = Number(value);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`DB_POOL_MAX must be a positive integer, got "${value}"`);
  }
  return max;
};

// `DATABASE_URL`, when set (e.g. by docker-compose, pointing at a real
// Postgres container), connects over the wire via Bun's native `Bun.sql`
// client. Left unset — the default for local `bun run dev`/`bun test` — this
// falls back to PGlite (an embedded Postgres), so there's no external
// service to run: `DB_PATH` is then a data *directory* PGlite persists its
// files under (unset = in-memory, thrown away on exit).
//
// When DATABASE_URL is set, migrations are NOT run on boot — use
// `bun run db:migrate` (or the Helm chart's pre-upgrade Job) to apply them
// separately. This avoids race conditions when multiple Kubernetes replicas
// boot concurrently. PGlite (local/test) still auto-migrates since it's
// always single-process.
export const DbLive = Layer.effect(
  Db,
  Effect.promise(async (): Promise<DrizzleDb> => {
    if (process.env.DATABASE_URL) {
      const db = drizzleBunSql({
        connection: {
          url: process.env.DATABASE_URL,
          max: parseDbPoolMax(process.env.DB_POOL_MAX),
        },
        schema,
      });
      return db;
    }
    const client = await createPglite();
    const db = drizzlePglite({ client, schema });
    await migratePglite(db, { migrationsFolder: "./drizzle" });
    return db;
  }),
);

// Standalone migration entry point — used by `bun run db:migrate`
// (scripts/migrate.ts) and the Helm chart's pre-upgrade Job. Connects,
// migrates, and returns; the caller is responsible for exiting the process.
export const runMigrations = async (): Promise<void> => {
  if (process.env.DATABASE_URL) {
    const db = drizzleBunSql(process.env.DATABASE_URL, { schema });
    await migrateBunSql(db, { migrationsFolder: "./drizzle" });
  } else {
    const client = await createPglite();
    const db = drizzlePglite({ client, schema });
    await migratePglite(db, { migrationsFolder: "./drizzle" });
    await client.close();
  }
};
