# Migrations

Generate with `bun run db:generate` from `src/db/schema.ts`.

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
Migrations before `0042` predate the check.

**A column old replicas don't write gets a database default**, not an
app-side one, because their inserts omit it: `users.created_at` (`0025`)
and `chat_participants.request_pending` (`0038`, default `false`) are the
pattern, so rows from old replicas and from before the migration read
sensibly.

**`0023` needs `pg_trgm`.** On real Postgres its `CREATE EXTENSION` is
enough (trusted since PG13). PGlite needs the bundle registered at creation,
which is why every instance goes through `createPglite` in `src/Db.ts`.
