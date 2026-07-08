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
| secrets    | `Secret`                           | `JWT_SECRET`, the Postgres password, and the Redis password. `values.yaml` defaults all three to `existingSecret`, pointing at Secrets (`jwt`, `postgres-password`, `redis-password`) created once by hand in-cluster — see note below. |

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
- `jwt.existingSecret` / `postgres.auth.existingSecret` /
  `redis.auth.existingSecret` — **required**, the name of a pre-existing
  Secret holding each value (the chart no longer generates these itself —
  see below for why). This repo's `values.yaml` defaults all three to
  Secrets (`jwt`, `postgres-password`, `redis-password`) created once by
  hand, e.g.:
  ```bash
  kubectl create secret generic postgres-password -n chat-platform \
    --from-literal=postgres-password="$(openssl rand -base64 24)"
  ```
  (same for `redis-password` / `jwt`, each with a data key matching its own
  Secret name — the chart reads the key by that same name, so there's no
  separate key field to set). **Why not have the chart auto-generate these
  password on first install?** An earlier version did exactly that (leave
  blank → generate a random value, reused across `helm upgrade` via a
  `lookup`-based helper that read back the existing Secret so it wouldn't
  rotate). That trick needs a live connection to the target cluster at
  render time, which plain `helm install`/`upgrade` has but ArgoCD's Helm
  rendering doesn't — so under ArgoCD, every auto-sync regenerated a fresh
  random password and overwrote the Secret, while the already-initialized
  Postgres/Redis didn't pick up the new value and stopped authenticating.
  Rather than only working under one of the two ways this chart gets
  deployed, `existingSecret` is now required unconditionally.

After install, `helm status chat-platform -n chat-platform` re-prints the
NOTES.txt output (API URL, rollout-status command).

### Upgrading

```bash
helm upgrade chat-platform ./chat-platform -n chat-platform \
  --set backend.image.tag=<new-tag>
```

Secrets aren't managed by this chart at all (see `existingSecret` above), so
there's nothing for `helm upgrade` to rotate or regenerate.

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
