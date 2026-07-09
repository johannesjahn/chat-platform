# Observability: VictoriaMetrics + Grafana

Cluster and node metrics for the microk8s cluster the [`chat-platform`
chart](../chat-platform/) runs on, via the community
[`victoria-metrics-k8s-stack`](https://github.com/VictoriaMetrics/helm-charts/tree/master/charts/victoria-metrics-k8s-stack)
Helm chart — a lighter-weight alternative to `kube-prometheus-stack` for a
single/small-node cluster (see #121). Sub-task of #121; this covers metrics
only — logs, application-level metrics, dashboards, and alerting are each
their own sub-issue and out of scope here.

The chart itself isn't vendored into this repo (unlike `../chat-platform/`,
which this repo owns) — it's installed straight from VictoriaMetrics' Helm
repo, with [`values.yaml`](values.yaml) here as the checked-in override file,
following the same "checked-in values + `helm install`/`upgrade`" pattern as
`../chat-platform/`.

## What's deployed

| Component                  | Role                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `vmsingle`                 | Single-node VictoriaMetrics — metrics storage (Prometheus-compatible). Sized for a microk8s cluster, no `vmcluster` needed. |
| `vmagent`                  | Scrapes kubelet/cAdvisor, `kube-state-metrics`, and `node-exporter`, remote-writes into `vmsingle`.                         |
| `kube-state-metrics`       | Object-level cluster state — deployments, pod restarts, PVC usage.                                                          |
| `prometheus-node-exporter` | Host-level CPU/mem/disk/network metrics.                                                                                    |
| Grafana                    | Dashboards/Explore UI, pointed at `vmsingle` as its datasource (wired up automatically — see `values.yaml`).                |

`vmalert`/Alertmanager and bundled Grafana dashboards/alerting rules are
disabled in `values.yaml` — alerting and dashboards are separate sub-issues
of #121, not part of this pass.

## Installing

```bash
helm repo add vm https://victoriametrics.github.io/helm-charts/
helm repo update

kubectl create secret generic grafana-admin -n observability --create-namespace \
  --from-literal=admin-user=admin \
  --from-literal=admin-password="$(openssl rand -base64 24)"

helm install vm-stack vm/victoria-metrics-k8s-stack \
  --namespace observability --create-namespace \
  -f values.yaml
```

(same `existingSecret` reasoning as `../chat-platform/`'s Postgres/Redis/JWT
secrets — see `../README.md` — so `helm upgrade` never rotates or
regenerates the Grafana admin password out from under you.)

Notable values (see [`values.yaml`](values.yaml) for the full set, with
comments):

- `vmsingle.spec.retentionPeriod` / `vmsingle.spec.storage.resources.requests.storage`
  — how much history to keep and how much disk to give it.
- `vmagent.spec.scrapeInterval` — how often the cluster is scraped.
- `grafana.ingress.*` — host, ingress class, and cert-manager annotations.
  Defaults assume a `traefik` `IngressClass` and cert-manager with a
  `letsencrypt` `ClusterIssuer`, matching `../chat-platform/values.yaml`;
  adjust or set `grafana.ingress.enabled: false` if your cluster's setup
  differs (use `kubectl port-forward -n observability svc/vm-stack-grafana
3000:80` instead).
- `grafana.admin.existingSecret` — required, the name of a pre-existing
  Secret holding the admin user/password (see above).
- `grafana.persistence.*` — size and `storageClassName` for Grafana's own
  DB (dashboards, users, etc. — not metrics, which live in `vmsingle`).

### Upgrading

```bash
helm upgrade vm-stack vm/victoria-metrics-k8s-stack -n observability -f values.yaml
```

### Validating locally

```bash
helm template vm-stack vm/victoria-metrics-k8s-stack -f values.yaml | kubectl apply --dry-run=client -f -
```

## Using it

- **Grafana**: reachable at `grafana.ingress.hosts[0]` (or via the
  `port-forward` command above), logging in with the `grafana-admin` secret's
  credentials. The `VictoriaMetrics` datasource is provisioned automatically
  (`defaultDatasources`/`grafana.sidecar.datasources` in `values.yaml`) — no
  manual datasource setup needed.
- **Querying metrics**: Grafana's **Explore** view, datasource
  `VictoriaMetrics`, e.g.:
  - Node CPU: `100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`
  - Node memory used: `node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes`
  - Pod restarts: `kube_pod_container_status_restarts_total`
  - PVC usage: `kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes`
