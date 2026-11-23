# chat-platform

Two packages in one repo:

- **Backend** (repo root, sources in `src/`): Bun + Effect `HttpApi`, Drizzle
  over PGlite (embedded Postgres) or a real Postgres when `DATABASE_URL` is
  set; realtime fan-out through Redis when `REDIS_URL` is set.
- **Frontend** (`web/`, own `package.json`): TanStack Start (React) in SPA
  mode, calling the backend over HTTP.

`docker compose up` runs Postgres, Redis and Garage (S3-compatible
attachment storage) with the backend wired to all three.

## Bun

Use Bun everywhere: `bun <file>`, `bun test`, `bun install`, `bun run
<script>`, `bunx`. Bun loads `.env` itself. On the backend prefer Bun's
built-ins: `Bun.sql`, `Bun.redis`, `Bun.file`, `Bun.$`, the global
`WebSocket`.

## Commands

| What                    | Root (backend)                     | `web/`                    |
| ----------------------- | ---------------------------------- | ------------------------- |
| Tests                   | `bun run test`                     | `bun run test` (unit)     |
| E2E                     |                                    | `bun run test:e2e`        |
| Typecheck (per package) | `bun run typecheck`                | `bun run gen:routes` then `bun run typecheck` |
| Lint / format (both)    | `bun run lint`, `bun run format:check` |                       |
| Regenerate API types    | `bun run gen:openapi`              | `bun run gen:types`       |
| Migrations              | `bun run db:generate`, `bun run db:migrate` |                  |

Run lint and format from the root: one `eslint.config.js` and
`.prettierrc.json` cover both packages.

`bun run test` passes `--timeout=15000` on purpose: `bunfig.toml`'s
`[test] timeout` is a Bun no-op. Its `coverageThreshold` _is_ enforced by
`bun run test:coverage`.

## Generated files

Regenerate these, never hand-edit them:

- `openapi.json` and `web/src/lib/api-types.ts`: after any backend API
  change run `cd web && bun run gen:types` and commit both. CI's `openapi`
  job fails on a diff.
- `web/src/routeTree.gen.ts` (gitignored): rebuilt by Vite; `bun run
gen:routes` produces it for a standalone typecheck.

## TypeScript 7 with the TS 6 API

Both packages typecheck with TypeScript 7 (`@typescript/native`, the `tsc`
binary) and install `typescript` as `npm:@typescript/typescript6` so
typescript-eslint and openapi-typescript still get a JS API.

Lockfile gotcha: Bun resolves the compat package's
`"@typescript/old": "npm:typescript@^6"` to the root alias, making it
require itself (`import "typescript"` turns up empty). Both `bun.lock` files
carry a hand-corrected `"typescript/@typescript/old"` entry pointing at the
real `typescript@6.x`. Re-check it whenever the compat package is bumped or
a lockfile is regenerated from scratch.

## Where the detail lives

Each area has its own `CLAUDE.md`, loaded when you work in that folder.
Read the one for an area before changing it from elsewhere:

- `src/CLAUDE.md`: backend-wide rules: database access, handler layout, API
  schemas, search, realtime, Redis outages, background jobs, notifications,
  media input, admin stats, backend tests.
- `src/chats/CLAUDE.md`: chat shared modules, message requests, forwarding.
- `src/games/CLAUDE.md`: arcade plumbing, adding a game, lobby chat, Reflex
  Rush. `src/games/drawing/CLAUDE.md`: Sketchy.
- `drizzle/CLAUDE.md`: migration rules (backward-compatible, checked by
  `src/migrationSafety.test.ts`).
- `web/CLAUDE.md`: frontend-wide rules: desktop layout, disclosure motion,
  bundle budget, unit tests.
- `web/src/routes/CLAUDE.md`: route loaders. `web/src/lib/CLAUDE.md`:
  realtime cache patching, the outbox.
  `web/src/components/chat/CLAUDE.md`: the conversation view.
- `web/e2e/CLAUDE.md`: Playwright suite rules.
- `.github/CLAUDE.md`: CI jobs, path filters, Renovate.
- `k8s/CLAUDE.md`: Helm chart constraints (PgBouncer, Redis, migrations).
