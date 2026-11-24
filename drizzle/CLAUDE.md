# Migrations

Generate with `bun run db:generate` from `src/db/schema.ts`.

**`0000` is a baseline** (issue #943) that replaced every migration before
it. Its "By hand" sections hold what Drizzle doesn't model and `db:generate`
leaves out: the `pg_trgm` extension, the generated `search_vector` columns,
the trigram indexes, and the trigger functions with their triggers. A
database migrated before the baseline has to be recreated, including its
`drizzle` schema.

**Who runs them.** PGlite (no `DATABASE_URL`) auto-migrates on boot. With
`DATABASE_URL` set, boot never migrates (issue #178, so replicas can't
race): `bun run db:migrate` does, run by the Helm chart's pre-upgrade
`backend-migration-job.yaml` and docker-compose's `db-migrate` service.

**Every migration stays backward-compatible (expand-contract).** During a
rolling deploy old replicas run against the already-migrated schema.
`src/migrationSafety.test.ts` fails on a migration that drops, renames or
retypes a table or column, makes one `NOT NULL` (or adds one without a
default), drops a default, or adds a `CHECK`/`UNIQUE` to an existing table.
The contract step is a later release's migration, and each statement in it
says why it's safe now with `-- migration-safety: allow <rule> (<why>)`.
The baseline isn't checked.

**A column old replicas don't write gets a database default**, not an
app-side one, because their inserts omit it.

**The baseline needs `pg_trgm`.** On real Postgres its `CREATE EXTENSION` is
enough (trusted since PG13). PGlite needs the bundle registered at creation,
which is why every instance goes through `createPglite` in `src/Db.ts`.
