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

## Testing

Two independent suites:

### Backend — `bun test ./src`

Bun's built-in test runner. [src/users.test.ts](src/users.test.ts) exercises the
Effect `HttpApi` in-process (no network): every test gets a **fresh in-memory
PGlite** database (real Postgres semantics, no server to run) with the
Drizzle migrations applied and a deterministic `JWT_SECRET`, so tests are
fully isolated and don't depend on a local `.env`.

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

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on pushes to `main`
and on every pull request, with four parallel jobs:

- **lint** — `format:check` + `lint`
- **typecheck** — backend and web (generates the route tree first)
- **unit** — `bun test ./src`
- **e2e** — Playwright, uploading traces as an artifact on failure

The Bun version is pinned in one place via the workflow's `BUN_VERSION` env var.
