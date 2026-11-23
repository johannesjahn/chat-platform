# Kubernetes

- **Migrations** run in the chart's pre-upgrade `backend-migration-job.yaml`;
  the backend never migrates on boot with `DATABASE_URL` set (see
  `drizzle/CLAUDE.md`).
- **Connections**: replicas × `DB_POOL_MAX` (default 10) must fit under
  Postgres's `max_connections`, or enable the optional PgBouncer
  (`pgbouncer.enabled`, transaction mode). Keep PgBouncer's
  `max_prepared_statements` above 0: Bun.sql uses named prepared
  statements.
- **Redis** can be a managed instance (`redis.enabled: false`,
  `redis.external.*`), but must stay a single endpoint, not Cluster mode:
  presence's Lua scripts build bucket keys they don't declare.
- The `BackendRedisUnreachable` alert reads `redis_connection_up`; readiness
  checks only the database (see "Redis outages" in `src/CLAUDE.md`).
