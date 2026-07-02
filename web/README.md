# chat-platform-web

A [TanStack Start](https://tanstack.com/start) (React) frontend for the
chat-platform backend, built in **SPA mode** (no SSR server). The browser calls
the backend API directly; the backend enables CORS for this origin.

## Run

Start the backend API first (from the repo root):

```sh
bun run dev            # backend on http://localhost:3000
```

Then start the web app (from this `web/` directory):

```sh
bun install
bun run dev            # frontend on http://localhost:3001
```

Open http://localhost:3001. Register or log in, and the home page lists all
users returned by the backend.

## Static build

```sh
bun run build          # emits static files to dist/client/
```

`dist/client/` (`index.html` + hashed `assets/`) is a fully static site — no
server of its own. Host it anywhere (CDN, object storage, nginx), with one rule:
**serve `index.html` as the fallback for unknown paths** so client-side routes
like `/login` resolve. `bun run preview` serves the build locally.

## Deploy (static host + separate backend)

Two settings must line up, one per side:

1. **Build the frontend against the backend's public URL.** `VITE_API_URL` is
   inlined at *build* time, so set it when building — not at runtime:

   ```sh
   VITE_API_URL=https://api.example.com bun run build
   ```

   Then upload `dist/client/` to your static host (with SPA fallback to
   `index.html`).

2. **Point the backend's CORS at the static site's origin** via `WEB_ORIGIN`
   (see the repo root `.env.example`), e.g. `WEB_ORIGIN=https://app.example.com`.
   The browser loads the app from that origin and calls `VITE_API_URL`; CORS
   must allow it.

## Generated API client

The API client is generated from the backend's OpenAPI spec, so requests and
responses stay in lockstep with the API contract:

```sh
bun run gen:types
```

This regenerates `../openapi.json` from the `ChatApi` definition (via
`OpenApi.fromApi`, no server needed) and writes `src/lib/api-types.ts` with
`openapi-typescript`. Re-run it whenever the backend API changes.

On top of those types, [src/lib/api.ts](src/lib/api.ts) exposes typed hooks via
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) +
[`openapi-react-query`](https://openapi-ts.dev/openapi-react-query/) — no
per-endpoint code is generated; the path/body/response types are all inferred:

```ts
const { data: users } = $api.useQuery("get", "/users");
const login = $api.useMutation("post", "/users/login");
await login.mutateAsync({ body: { username, password } });
```

Data fetching runs through [TanStack Query](https://tanstack.com/query); the
provider is set up in `src/routes/__root.tsx`.

## Config

- `VITE_API_URL` — base URL of the backend API (default `http://localhost:3000`).
  Must be reachable from the browser and allowed by the backend's CORS origin.

## Pages

- `/` — welcome + list of registered users (`GET /users`)
- `/register` — create an account (`POST /users/register`, then auto-login)
- `/login` — log in and store the issued access/refresh JWTs (`POST /users/login`)
