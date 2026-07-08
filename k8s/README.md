# Kubernetes deployment

This directory contains a Helm chart ([`chat-platform/`](chat-platform/)) that
deploys the **backend**, **Postgres**, and **Redis** to a Kubernetes cluster.
It takes inspiration from
[johannesjahn/chat-api-helm](https://github.com/johannesjahn/chat-api-helm),
adapted for this repo's stack (Bun backend, `/health`/`/ready` probes, a
single combined Postgres+Redis secret) and modernized a bit (PVCs/a
StatefulSet instead of `hostPath` volumes, so it isn't pinned to a single
node).

The **frontend** (`../web/`) is deployed differently — as a static SPA on
[Cloudflare Workers](https://developers.cloudflare.com/workers/static-assets/),
not into the cluster. See
[Frontend: Cloudflare Workers](#frontend-cloudflare-workers) below.

## What's in the chart

| Component  | Kind                               | Notes                                                                                                                                                                  |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`  | `Deployment` + `Service`           | The Bun/Effect API. `Ingress` optional (on by default).                                                                                                                |
| `postgres` | `StatefulSet` + headless `Service` | Persisted via a `volumeClaimTemplate` (disable with `postgres.persistence.enabled=false`).                                                                             |
| `redis`    | `Deployment` + `Service`           | Backs realtime Pub/Sub fan-out and rate limiting; no persistence by default.                                                                                           |
| secrets    | `Secret`                           | `JWT_SECRET`, the Postgres password, and the Redis password — auto-generated on first install if left blank, or bring your own via `existingSecret` (see values.yaml). |

Nothing here builds the backend's container image — the chart just deploys
one. Build and push the repo-root [`Dockerfile`](../Dockerfile) to a
registry your cluster can pull from first:

```bash
docker build -t ghcr.io/<you>/chat-platform:<tag> .
docker push ghcr.io/<you>/chat-platform:<tag>
```

## Installing

```bash
helm install chat-platform ./chat-platform \
  --namespace chat-platform --create-namespace \
  --set backend.image.repository=ghcr.io/<you>/chat-platform \
  --set backend.image.tag=<tag> \
  --set backend.ingress.host=api.<your-domain> \
  --set backend.webOrigin=https://<your-frontend-domain>
```

Or copy `chat-platform/values.yaml` to your own `my-values.yaml`, edit it,
and run `helm install chat-platform ./chat-platform -f my-values.yaml -n
chat-platform --create-namespace` instead.

Notable values (see [`chat-platform/values.yaml`](chat-platform/values.yaml)
for the full set, with comments):

- `backend.image.repository` / `backend.image.tag` — where to pull the
  backend image from.
- `backend.webOrigin` — must match the frontend's origin(s) exactly; the
  backend's CORS middleware (`src/main.ts`) only allows the origin(s) listed
  here. Comma-separate multiple values if the frontend is reachable at more
  than one origin (e.g. a custom domain plus its `*.workers.dev` URL).
- `backend.ingress.*` — host, ingress class, and cert-manager annotations.
  Defaults assume an `nginx` `IngressClass` and cert-manager with a
  `letsencrypt-prod` `ClusterIssuer`; adjust or set `backend.ingress.enabled:
false` if your cluster's setup differs.
- `postgres.persistence.*` / `redis.persistence.*` — size and
  `storageClassName` (empty uses the cluster default).
- `jwt.secret`, `postgres.auth.password`, `redis.auth.password` — leave blank
  to auto-generate a random value on first install (the value is then
  read back from the existing `Secret` on every `helm upgrade`, not
  rotated). Set `jwt.existingSecret` / `postgres.auth.existingSecret` /
  `redis.auth.existingSecret` instead to supply your own pre-created
  `Secret` (recommended for production, e.g. managed via
  [External Secrets](https://external-secrets.io/) or sealed-secrets).

After install, `helm status chat-platform -n chat-platform` re-prints the
NOTES.txt output (API URL, rollout-status command).

### Upgrading

```bash
helm upgrade chat-platform ./chat-platform -n chat-platform \
  --set backend.image.tag=<new-tag>
```

Auto-generated secrets are preserved across upgrades (see
`templates/_helpers.tpl`'s `chat-platform.secretValue`) — they're only
generated once, on first install.

### Validating the chart locally

```bash
helm lint ./chat-platform
helm template chat-platform ./chat-platform | kubectl apply --dry-run=client -f -
```

## Frontend: Cloudflare Workers

The frontend (`../web/`) is a client-side-rendered SPA (TanStack Start in SPA
mode — see `web/vite.config.ts`), so it doesn't need a Kubernetes deployment
or a Node/Bun server at runtime; it's deployed as a Cloudflare Worker with
static assets (`web/wrangler.jsonc`), which serves the build output directly
from Cloudflare's CDN with no Worker script needed. Cloudflare now steers new
static sites toward Workers instead of Pages (`wrangler pages` errors out
telling you to use `wrangler deploy` if the Pages project doesn't already
exist), so this repo targets Workers directly.

Deploys are pushed from GitHub Actions
([`.github/workflows/workers-deploy.yml`](../.github/workflows/workers-deploy.yml))
via `wrangler deploy` on every push to `main` that touches `web/`. Unlike
Pages, there's no project to pre-create — `wrangler deploy` creates/updates
the Worker named in `web/wrangler.jsonc` (`chat-platform`) on first run.

**One-time setup**, before the workflow can deploy:

| What                    | Where                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | Repo secret — a token with "Workers Scripts: Edit" permission (dashboard → Manage Account → API Tokens).                                                                 |
| `CLOUDFLARE_ACCOUNT_ID` | Repo secret — shown in the Cloudflare dashboard's right sidebar.                                                                                                         |
| `VITE_API_URL`          | Repo **variable** (not secret — it ends up in client-side JS regardless). The backend's public URL, e.g. `https://api.<your-domain>` (the `backend.ingress.host` above). |

- **`VITE_API_URL`** is baked in at build time and read by
  `web/src/lib/api.ts`; without it the frontend falls back to
  `http://localhost:3000`, which won't resolve in production.
- **Build output is `dist/client`, not `dist`** — the build also emits a
  `dist/server` (an SSR/prerender artifact TanStack Start produces
  internally); `web/wrangler.jsonc`'s `assets.directory` points only at
  `dist/client`.
- **Client-side routing fallback** — `web/wrangler.jsonc` sets
  `assets.not_found_handling: "single-page-application"`, so the Worker
  serves `index.html` for any deep link instead of a 404 (this replaces the
  old Pages-era `_redirects` file, which is no longer needed).
- **CORS** — set the chart's `backend.webOrigin` to this exact Worker URL
  (custom domain, or `<name>.<subdomain>.workers.dev` if you're not using
  one). If the frontend needs to be reachable at both a custom domain and
  its `*.workers.dev` URL, comma-separate them, e.g.
  `https://chat.example.com,https://chat-platform.<subdomain>.workers.dev`
  — the backend's CORS middleware (`src/main.ts`) allows every origin
  listed.
- **Worker name** — set by `name` in `web/wrangler.jsonc` (`chat-platform`);
  update it there if you want a different name.
