# chat-platform

A small chat-platform API built with **Bun**, **Effect** (`HttpApi`), and
**Drizzle ORM** over **PGlite** (an embedded Postgres), plus a **TanStack
Start** (React) frontend in [`web/`](web/). See [web/README.md](web/README.md)
for frontend-specific docs.

## Install & run

```bash
bun install
bun run dev            # backend on http://localhost:3000 (--hot reload)
```

`bun run start` runs without hot reload. The API docs (Swagger) are served at
http://localhost:3000/docs. The database is a local PGlite data directory
(`DB_PATH`, unset = in-memory), created and migrated automatically on startup.

`GET /health` (liveness — the process is up) and `GET /ready` (readiness —
the DB, and Redis when `REDIS_URL` is set, are reachable) are unauthenticated
ops endpoints for orchestrators/load balancers; see
[`src/Health.ts`](src/Health.ts). They aren't part of `ChatApi`, so they
don't appear in the Swagger docs or the generated frontend client.

### Running against a real Postgres and Redis

```bash
cp .env.example .env   # then fill in JWT_SECRET/POSTGRES_PASSWORD/REDIS_PASSWORD
docker compose up --build
```

`docker-compose.yml` refuses to start unless `JWT_SECRET`, `POSTGRES_PASSWORD`,
and `REDIS_PASSWORD` are set (no insecure fallback defaults — see
[`.env.example`](.env.example)); `docker compose` reads them from a `.env`
file in the repo root automatically.

Starts a real Postgres and Redis container plus the backend (built from the
root [`Dockerfile`](Dockerfile)) connected to both via `DATABASE_URL`/
`REDIS_URL` — see [`docker-compose.yml`](docker-compose.yml). Migrations run
automatically on startup, same as the PGlite path. The backend is on
http://localhost:3000; set `DATABASE_URL`/`REDIS_URL` yourself (see
[`.env.example`](.env.example)) to point `bun run dev`/`start` at that same
Postgres/Redis instead of the in-process defaults (embedded PGlite, and an
in-memory realtime fan-out that only works for a single instance — see
[`src/PubSub.ts`](src/PubSub.ts)).

## Testing

Two independent suites:

### Backend — `bun test ./src`

Bun's built-in test runner. [src/users.test.ts](src/users.test.ts) exercises the
Effect `HttpApi` in-process (no network): every test gets a **fresh in-memory
PGlite** database (real Postgres semantics, no server to run) with the
Drizzle migrations applied and a deterministic `JWT_SECRET`, so tests are
fully isolated and don't depend on a local `.env`. Realtime delivery uses the
in-memory `PubSub` fallback everywhere except
[src/RealtimePubSub.integration.test.ts](src/RealtimePubSub.integration.test.ts),
which needs a real Redis at `REDIS_URL` and skips itself when one isn't
configured.

### End-to-end — `cd web && bun run test:e2e`

[Playwright](https://playwright.dev) (Chromium) drives the real frontend against
the real backend. The `webServer` block in
[web/playwright.config.ts](web/playwright.config.ts) boots **both** servers for
the run — the backend (`bun run start`, with a test `JWT_SECRET`) and the Vite
dev server — so a single command spins up everything. First-time setup needs the
browser binary:

```sh
cd web
bunx playwright install --with-deps chromium
bun run test:e2e
```

On CI, failed runs retry twice and capture traces (`trace: "on-first-retry"`).

## Code generation

Several files are generated rather than hand-written — **do not edit them
directly**; re-run the relevant command instead. All are gitignored.

| Artifact                   | Command                        | What it does                                                                                                                                                                           |
| -------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openapi.json`             | `bun run gen:openapi`          | Emits the OpenAPI spec from the `ChatApi` definition via `OpenApi.fromApi` (no server needed).                                                                                         |
| `web/src/lib/api-types.ts` | `cd web && bun run gen:types`  | Regenerates `openapi.json`, then the typed API client from it with `openapi-typescript`. Re-run after any backend API change.                                                          |
| `web/src/routeTree.gen.ts` | `cd web && bun run gen:routes` | TanStack Router's route tree (`tsr generate`). Normally produced automatically by the Vite plugin during `dev`/`build`; run this to generate it standalone (e.g. before typechecking). |

## Lint, format, typecheck

Prettier and ESLint are configured **once at the repo root** and cover both the
backend and the `web/` frontend (single `eslint.config.js` + `.prettierrc.json`).

```bash
bun run format         # write Prettier formatting
bun run format:check   # verify formatting (used in CI)
bun run lint           # ESLint (bun run lint:fix to autofix)
bun run typecheck      # backend types; run the same in web/ for the frontend
```

## Deployment

- **Docker Compose** — `docker compose up` (see above) for a local real
  Postgres + Redis + backend stack.
- **Kubernetes** — [`k8s/`](k8s/) has a Helm chart deploying the backend,
  Postgres, and Redis to a cluster. The frontend deploys separately to
  Cloudflare Workers instead — see [k8s/README.md](k8s/README.md) for both.

The root `package.json`'s `version` is the source of truth for releases (see
[`.github/workflows/tag-release.yml`](.github/workflows/tag-release.yml)) and
must stay in sync with the Helm chart's version fields
(`k8s/chat-platform/Chart.yaml`'s `version`/`appVersion` and
`values.yaml`'s `backend.image.tag`). After bumping the root
`package.json`'s version, run:

```bash
bun run sync:chart-version
```

and commit the result. CI's `chart-version` job re-runs this and fails the
build on drift. `web/package.json`'s version is independent and doesn't need
to match.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on pushes to `main`
and on every pull request, with five parallel jobs:

- **lint** — `format:check` + `lint`
- **typecheck** — backend and web (generates the route tree first)
- **openapi** — regenerates `openapi.json`/`web/src/lib/api-types.ts` and fails on drift
- **unit** — `bun test ./src`, with a Redis service container for the one test that needs it
- **e2e** — Playwright, uploading traces as an artifact on failure

The Bun version is pinned in one place via the workflow's `BUN_VERSION` env var.
