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
[Cloudflare Pages](https://pages.cloudflare.com/), not into the cluster. See
[Frontend: Cloudflare Pages](#frontend-cloudflare-pages) below.

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
- `backend.webOrigin` — must match the frontend's origin exactly; the
  backend's CORS middleware (`src/main.ts`) only allows this one origin.
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

## Frontend: Cloudflare Pages

The frontend (`../web/`) is a client-side-rendered SPA (TanStack Start in SPA
mode — see `web/vite.config.ts`), so it doesn't need a Kubernetes deployment
or a Node/Bun server at runtime; Cloudflare Pages serves the static build
output directly from its CDN.

Deploys are pushed from GitHub Actions
([`.github/workflows/pages-deploy.yml`](../.github/workflows/pages-deploy.yml))
via `wrangler pages deploy` on every push to `main` that touches `web/`,
rather than Cloudflare's own Git integration — this keeps the deploy trigger
in the same CI as the rest of the repo (see `docker-publish.yml` for the
backend equivalent) instead of Cloudflare building on its own schedule. That
means the Pages project needs to exist as a **Direct Upload** project (no
Git connection) before the workflow can push to it:

```bash
bunx wrangler pages project create chat-platform
```

(or via the dashboard — Workers & Pages → Create → Pages → Upload assets —
just don't connect it to the GitHub repo, since the workflow triggers builds
instead.)

**One-time setup**, before the workflow can deploy:

| What                    | Where                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | Repo secret — a token with "Cloudflare Pages: Edit" permission (dashboard → Manage Account → API Tokens).                                                                |
| `CLOUDFLARE_ACCOUNT_ID` | Repo secret — shown in the Cloudflare dashboard's right sidebar.                                                                                                         |
| `VITE_API_URL`          | Repo **variable** (not secret — it ends up in client-side JS regardless). The backend's public URL, e.g. `https://api.<your-domain>` (the `backend.ingress.host` above). |

- **`VITE_API_URL`** is baked in at build time and read by
  `web/src/lib/api.ts`; without it the frontend falls back to
  `http://localhost:3000`, which won't resolve in production.
- **Build output is `dist/client`, not `dist`** — the build also emits a
  `dist/server` (an SSR/prerender artifact TanStack Start produces
  internally); the workflow only deploys `dist/client`.
- **Client-side routing fallback** — [`web/public/_redirects`](../web/public/_redirects)
  (`/* /index.html 200`) is already in place so Pages serves `index.html` for
  any deep link instead of a 404; Vite copies it into `dist/client`
  automatically.
- **CORS** — set the chart's `backend.webOrigin` to this exact Pages URL
  (custom domain, or `<project-name>.pages.dev` if you're not using one). The
  backend only allows one CORS origin — a Direct Upload project has no
  Git-integration preview deployments to worry about, so this isn't the
  tradeoff it would be with the dashboard-managed flow.
- **Project name** — the workflow deploys with `--project-name=chat-platform`;
  update that flag if you named the Pages project something else.
