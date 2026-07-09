Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Project layout

This is a two-package repo:

- **Backend** (repo root): Bun + Effect `HttpApi`, Drizzle ORM over `PGlite`
  by default (an embedded Postgres — `DB_PATH` data directory, unset =
  in-memory, auto-migrated on startup). Set `DATABASE_URL` to instead connect
  to a real Postgres over the wire via `drizzle-orm/bun-sql` (`Bun.sql`) — see
  [`src/Db.ts`](src/Db.ts). Realtime (chat/post) events fan out through
  [`src/PubSub.ts`](src/PubSub.ts): an in-memory implementation by default
  (correct for a single process), or Redis Pub/Sub (`Bun.redis`) when
  `REDIS_URL` is set, so multiple horizontally-scaled instances share events
  — see [`src/Realtime.ts`](src/Realtime.ts). `docker compose up` (see
  [`docker-compose.yml`](docker-compose.yml) and [`Dockerfile`](Dockerfile))
  runs a real Postgres and Redis plus the backend wired to both. Sources in
  `src/`.
- **Frontend** (`web/`): TanStack Start (React) in SPA mode, calling the backend
  over HTTP. Has its own `package.json`.

Tooling (Prettier, ESLint, TypeScript) lives at the root and covers **both**
packages — there is a single `eslint.config.js` and `.prettierrc.json`. Run
lint/format from the repo root; run `typecheck` per package.

## Testing

- **Backend** — `bun test ./src --parallel --timeout=15000` (Bun's test
  runner; `--parallel` runs test files across worker processes instead of
  one after another — see below). The `--timeout` flag is load-bearing, not
  cosmetic: `bunfig.toml`'s `[test] timeout` looks like it should do the same
  thing but is a documented Bun no-op (every test silently gets the 5000ms
  default regardless — see the comment in `bunfig.toml`), so the flag on the
  CLI/script is the only thing actually raising it. Tests in
  [src/users.test.ts](src/users.test.ts) drive the
  Effect `HttpApi` through an in-process web handler, with a deterministic
  `JWT_SECRET`. No server or network, fully isolated per test. Each test
  file that calls `makeTestDbAccessor()` (see [src/testDb.ts](src/testDb.ts))
  boots one in-memory PGlite instance shared across that file's tests
  (migrated once via Drizzle from `./drizzle`), with a plain `TRUNCATE`
  between tests restoring a clean slate — cheaper than booting a fresh
  PGlite instance per test while keeping tests isolated as if each had. The
  instance is closed automatically once the file's tests finish; PGlite is a
  real (WASM-embedded) Postgres, so the first boot is still slower than
  `bun:sqlite` was — see the `--timeout` flag noted above. Every test file
  provides `InMemoryPubSubLive` for `RealtimeConnectionsLive`'s `PubSub`
  dependency, except
  [src/RealtimePubSub.integration.test.ts](src/RealtimePubSub.integration.test.ts),
  which needs a real Redis at `REDIS_URL` (CI provides one as a service
  container — see `.github/workflows/ci.yml`) and skips itself otherwise.
  `--parallel` is safe here because PGlite instances, ports (integration
  tests grab a free ephemeral port), and Redis usage (only one file touches
  it) are all already isolated per file/process — don't add `test.concurrent`
  within a file, though, since tests sharing one file's PGlite instance still
  reset it between each other and aren't safe to run concurrently.
- **E2E** — `cd web && bun run test:e2e` (Playwright, Chromium). The Playwright
  `webServer` config boots the _real_ backend (`bun run start`, cwd `..`, with a
  test `JWT_SECRET`) and the Vite dev server, then drives the browser against
  them. Configured in [web/playwright.config.ts](web/playwright.config.ts).

## Code generation

Three artifacts are generated, not hand-written — don't edit them by hand.
`openapi.json` and `web/src/lib/api-types.ts` are **checked into git**
(regenerate and commit them after any backend API change); `routeTree.gen.ts`
is gitignored and rebuilt on every dev/build.

- **OpenAPI spec** — `bun run gen:openapi` (root) writes `openapi.json` from the
  `ChatApi` definition via `OpenApi.fromApi` (no running server needed).
- **Frontend API types** — `cd web && bun run gen:types` regenerates
  `openapi.json` and then `web/src/lib/api-types.ts` with `openapi-typescript`.
  Re-run after any backend API change so the typed client stays in sync, and
  commit both files — the `openapi` CI job fails the build if regenerating
  them produces a diff from what's committed.
- **Route tree** — `web/src/routeTree.gen.ts` is produced by TanStack Router.
  The Vite plugin regenerates it during `bun run dev`/`build`; to produce it
  without Vite (e.g. before a standalone `typecheck`) run
  `cd web && bun run gen:routes` (`tsr generate`).

### Pitfall: `identifier`-annotated path/query/header schemas lose their params

Don't add `.annotations({ identifier: "..." })` to a `Schema.Struct` passed to
`.setPath(...)`, `.setUrlParams(...)`, or `.setHeaders(...)` on an
`HttpApiEndpoint`. Doing so makes `OpenApi.fromApi` emit that struct as a
`$ref` to a named component schema instead of inlining it — and its
parameter-extraction pass only reads inline `properties`, so it silently
drops the parameters instead of erroring. The endpoint still works at
runtime (Effect decodes the params fine); only the generated `openapi.json`
— and therefore the typed frontend client generated from it via
`gen:types` — ends up with zero documented/typed params for that endpoint.
Leave those structs anonymous (see `PostsPageQuery` in [src/Api.ts](src/Api.ts)
for the pattern). `src/openapi.test.ts` guards against a regression by
asserting every endpoint with a path/query/header schema produces matching
OpenAPI parameters — run it (`bun test ./src`) after touching any endpoint
signature.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on pushes to `main`
and all PRs, with five parallel jobs: **lint** (`format:check` + `lint`),
**typecheck** (backend + web; generates the route tree first), **openapi**
(regenerates `openapi.json` and `web/src/lib/api-types.ts` via `gen:types` and
fails if that produces a diff, i.e. catches a backend API change whose
generated spec/types weren't regenerated and committed), **unit**
(`bun test ./src`, which includes `src/openapi.test.ts` validating the spec
against the `ChatApi` definition), and **e2e** (Playwright). The Bun version
is pinned once via the workflow-level `BUN_VERSION` env var.
