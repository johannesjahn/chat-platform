# Observability: VictoriaMetrics + Loki + Grafana

Cluster/node metrics, cluster/application logs, dashboards, and alerting for
the microk8s cluster the [`chat-platform` chart](../chat-platform/) runs on,
via the community
[`victoria-metrics-k8s-stack`](https://github.com/VictoriaMetrics/helm-charts/tree/master/charts/victoria-metrics-k8s-stack)
(metrics + vmalert/Alertmanager + dashboards — a lighter-weight alternative
to `kube-prometheus-stack` for a single/small-node cluster),
[`loki`](https://github.com/grafana/loki/tree/main/production/helm/loki), and
[`alloy`](https://github.com/grafana/alloy/tree/main/operations/helm/charts/alloy)
(logs) Helm charts, sharing one Grafana instance (see #121, #122, #123,
#125). The backend's own application-level metrics (issue #124) _are_
covered, but live in [`../chat-platform/`](../chat-platform/) — its
`VMServiceScrape`, Grafana dashboard ConfigMap, and `VMRule` (alert rules)
are picked up by the `vmagent`/Grafana/`vmalert` deployed here automatically
(see `values.yaml`'s `grafana.sidecar.dashboards` and
`vmalert.spec.selectAllByDefault`), nothing to configure on this side beyond
that.

None of these charts are vendored into this repo (unlike `../chat-platform/`,
which this repo owns) — they're installed straight from their upstream Helm
repos, declared in [`helmfile.yaml`](helmfile.yaml) with
[`values.yaml`](values.yaml) (vm-stack), [`loki-values.yaml`](loki-values.yaml),
and [`alloy-values.yaml`](alloy-values.yaml) here as the checked-in override
files. Helmfile (rather than a plain `helm install`/`upgrade`, as
`../chat-platform/` documents) makes this stack syncable declaratively,
including from ArgoCD — see [Deploying via ArgoCD](#deploying-via-argocd)
below.

## What's deployed

| Component                  | Role                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vmsingle`                 | Single-node VictoriaMetrics — metrics storage (Prometheus-compatible). Sized for a microk8s cluster, no `vmcluster` needed.                                                                                                                                                                        |
| `vmagent`                  | Scrapes kubelet/cAdvisor, `kube-state-metrics`, `node-exporter`, and any `VMServiceScrape` in the cluster (including the backend's, from `../chat-platform/`), remote-writes into `vmsingle`.                                                                                                      |
| `kube-state-metrics`       | Object-level cluster state — deployments, pod restarts, PVC usage.                                                                                                                                                                                                                                  |
| `prometheus-node-exporter` | Host-level CPU/mem/disk/network metrics.                                                                                                                                                                                                                                                            |
| `loki`                     | Single-binary Loki — log storage (LogQL), filesystem storage backend on a PVC. Sized for a microk8s cluster, no scalable/distributed deployment mode needed.                                                                                                                                       |
| `alloy`                    | Grafana Alloy (Loki's currently-recommended log collector) as a DaemonSet — discovers every pod via the k8s API and tails its logs through the API server (no hostPath mount needed), labeling each entry by namespace/pod/container, and ships them to `loki`.                                   |
| Grafana                    | Dashboards/Explore UI, pointed at both `vmsingle` and `loki` as datasources (wired up automatically — see `values.yaml`). Auto-loads any dashboard ConfigMap labeled `grafana_dashboard: "1"` across every namespace, including the backend's (see `values.yaml`'s `grafana.sidecar.dashboards`). |
| `vmalert`                  | Evaluates `VMRule` resources against `vmsingle` (datasource wired up automatically) and fires into `alertmanager` (notifiers wired up automatically) — picks up `VMRule`s cluster-wide, same discovery pattern as `vmagent`'s `VMServiceScrape`s.                                                 |
| Alertmanager               | Routes/dedupes/notifies on alerts `vmalert` fires. Its config comes from a pre-existing Secret (`alertmanager.spec.configSecret`), not `values.yaml` — see [Alerting](#alerting) below.                                                                                                            |

Loki's log retention is set explicitly (`loki-values.yaml`'s
`loki.limits_config.retention_period` / `loki.compactor`) rather than left
at the chart's unbounded default, since logs otherwise grow forever on the
PVC. Bundled community Grafana dashboards (`defaultDashboards.enabled`) are
on; the `victoria-metrics-k8s-stack` chart's own bundled alerting rule
bundle (`defaultRules.enabled`) is off in favor of the smaller, explicit
rule set below — see [Dashboards](#dashboards) and [Alerting](#alerting).

## Installing

Requires the [`helmfile`](https://helmfile.readthedocs.io/) CLI (which
shells out to `helm` — no separate `helm repo add` needed, `helmfile.yaml`'s
`repositories:` block handles that).

```bash
kubectl create secret generic grafana-admin -n observability --create-namespace \
  --from-literal=admin-user=admin \
  --from-literal=admin-password="$(openssl rand -base64 24)"

# See "Alerting" below for what goes in alertmanager.yaml — a minimal
# starting point (an unauthenticated webhook receiver) is shown there.
kubectl create secret generic alertmanager-config -n observability \
  --from-file=alertmanager.yaml=./alertmanager.yaml

helmfile apply
```

(same `existingSecret`/`configSecret` reasoning as `../chat-platform/`'s
Postgres/Redis/JWT secrets — see `../README.md` — so re-running `helmfile
apply` never rotates or regenerates the Grafana admin password, and never
overwrites your real Alertmanager receiver config with a placeholder, out
from under you.)

Notable values (see [`values.yaml`](values.yaml)/[`loki-values.yaml`](loki-values.yaml)/[`alloy-values.yaml`](alloy-values.yaml)
for the full set, with comments):

- `vmsingle.spec.retentionPeriod` / `vmsingle.spec.storage.resources.requests.storage`
  — how much metrics history to keep and how much disk to give it.
- `vmagent.spec.scrapeInterval` — how often the cluster is scraped.
- `loki-values.yaml`'s `loki.limits_config.retention_period` — how much log
  history to keep (14 days by default); `singleBinary.persistence.size` —
  how much disk to give it.
- `alloy-values.yaml`'s `alloy.configMap.content` — the Alloy config
  (discovery + relabeling + where logs get shipped); rarely needs touching.
- `grafana.ingress.*` — host, ingress class, and cert-manager annotations.
  Defaults assume a `traefik` `IngressClass` and cert-manager with a
  `letsencrypt` `ClusterIssuer`, matching `../chat-platform/values.yaml`;
  adjust or set `grafana.ingress.enabled: false` if your cluster's setup
  differs (use `kubectl port-forward -n observability svc/vm-stack-grafana
3000:80` instead).
- `grafana.admin.existingSecret` — required, the name of a pre-existing
  Secret holding the admin user/password (see above).
- `grafana.persistence.*` — size and `storageClassName` for Grafana's own
  DB (dashboards, users, etc. — not metrics/logs, which live in
  `vmsingle`/`loki`).

### Upgrading

`helmfile apply` (above) is idempotent — it diffs the rendered manifests
against the live cluster and only applies what changed, so it's the same
command for first install and every subsequent upgrade (e.g. after bumping
`helmfile.yaml`'s `version:` or editing `values.yaml`).

### Validating locally

```bash
helmfile lint
helmfile template | kubectl apply --dry-run=client -f -
```

### Chart version

`helmfile.yaml`'s `releases[].version` pins each chart version — bump
deliberately (check the upstream Chart.yaml and changelog first) rather than
floating on whatever `helm repo update` last cached, so renders stay
reproducible across machines and ArgoCD syncs:

- `victoria-metrics-k8s-stack` — [Chart.yaml](https://github.com/VictoriaMetrics/helm-charts/blob/master/charts/victoria-metrics-k8s-stack/Chart.yaml)
- `loki` — [Chart.yaml](https://github.com/grafana/loki/blob/main/production/helm/loki/Chart.yaml)
- `alloy` — [Chart.yaml](https://github.com/grafana/alloy/blob/main/operations/helm/charts/alloy/Chart.yaml)

## Deploying via ArgoCD

ArgoCD has no built-in Helmfile support, but it does support running one as
a [Config Management Plugin
(CMP)](https://argo-cd.readthedocs.io/en/stable/operator-manual/config-management-plugins/)
sidecar on `argocd-repo-server`, which renders `helmfile.yaml` the same way
`helmfile template` does above. This is a one-time change to your ArgoCD
installation (not something this repo's `helmfile.yaml` needs to know
about), so it lives wherever you already manage ArgoCD itself (e.g. the
`argo-cd` Helm chart's values) — not checked in here. Roughly, following
[Christian Huth's writeup](https://christianhuth.de/deploying-helm-charts-using-argocd-and-helmfile/):

1. Add a `helmfile` sidecar + its plugin config to the `argocd-repo-server`
   (as `argo-cd` chart values, if that's how ArgoCD is installed). **Pin a
   current `helmfile` image tag** — `victoria-metrics-k8s-stack` requires
   Helm ≥3.14.0, and older/pre-v1 `helmfile` image tags bundle an older Helm
   that doesn't meet that, failing `helmfile template` inside the sidecar
   with `This chart requires helm version 3.14.0 or higher`. Tags `v1.5.4`
   and newer bundle Helm v4.2.x, which satisfies it:

   ```yaml
   repoServer:
     extraContainers:
       - name: helmfile
         image: ghcr.io/helmfile/helmfile:v1.7.0
         command: ["/var/run/argocd/argocd-cmp-server"]
         env:
           - name: HELM_CACHE_HOME
             value: /tmp/helm/cache
           - name: HELM_CONFIG_HOME
             value: /tmp/helm/config
           - name: HELMFILE_CACHE_HOME
             value: /tmp/helmfile/cache
           - name: HELMFILE_TEMPDIR
             value: /tmp/helmfile/tmp
         securityContext:
           runAsNonRoot: true
           runAsUser: 999
         volumeMounts:
           - mountPath: /var/run/argocd
             name: var-files
           - mountPath: /home/argocd/cmp-server/plugins
             name: plugins
           - mountPath: /home/argocd/cmp-server/config/plugin.yaml
             subPath: helmfile.yaml
             name: argocd-cmp-cm
           - mountPath: /tmp
             name: cmp-tmp
     volumes:
       - name: argocd-cmp-cm
         configMap:
           name: argocd-cmp-cm
       - name: cmp-tmp
         emptyDir: {}
   ```

2. Register the plugin itself, as a `ConfigManagementPlugin` in the
   `argocd-cmp-cm` ConfigMap referenced above (key `helmfile.yaml`):

   ```yaml
   apiVersion: argoproj.io/v1alpha1
   kind: ConfigManagementPlugin
   metadata:
     name: helmfile
   spec:
     allowConcurrency: true
     discover:
       fileName: helmfile.yaml
     generate:
       command:
         - bash
         - "-c"
         - helmfile -n "$ARGOCD_APP_NAMESPACE" template --include-crds -q
     lockRepo: false
   ```

3. Point an `Application` at this directory — `discover.fileName` above
   means ArgoCD auto-detects the plugin from the presence of
   `helmfile.yaml`, so no `spec.source.plugin` needed:

   ```yaml
   apiVersion: argoproj.io/v1alpha1
   kind: Application
   metadata:
     name: observability
     namespace: argocd
   spec:
     project: default
     source:
       repoURL: https://github.com/johannesjahn/chat-platform.git
       targetRevision: main
       path: k8s/observability
     destination:
       server: https://kubernetes.default.svc
       namespace: observability
     syncPolicy:
       automated:
         prune: true
         selfHeal: true
       syncOptions:
         - CreateNamespace=true
   ```

   The `grafana-admin` Secret still needs to exist before the first sync —
   ArgoCD manages the Helmfile-rendered resources, not that one-time manual
   step (see Installing above).

## Dashboards

`defaultDashboards.enabled: true` provisions `victoria-metrics-k8s-stack`'s
bundled community dashboards — `node-exporter-full` (per-node CPU/mem/disk/
network, the "node-exporter's standard dashboard" #125 asks for) and the
`kubernetes-views-*` set (cluster/namespace/pod/node overviews, standing in
for a kube-state-metrics cluster-overview dashboard) chief among them.
Dashboards for components this cluster doesn't run (etcd, kube-scheduler/
controller-manager/kube-proxy metrics — microk8s doesn't expose these the
standard way) are individually gated by the chart on their own
`kubeScheduler.enabled`-style flags, which are unset here, so they don't
show up and sit empty. On top of those, the "chat-platform app" dashboard
from #124 is pre-provisioned by `../chat-platform/` — see "Using it" below.

Log-panel dashboards (Loki) aren't provisioned — #123 (the log stack) isn't
deployed yet, so there's no Loki datasource to build them on.

## Alerting

`vmalert` evaluates `VMRule` resources (cluster-wide, no namespace
restriction) against `vmsingle` and fires into Alertmanager, which routes
notifications per `alertmanager-config`'s config (see Installing above — not
`values.yaml`, so a real receiver URL/token never ends up in git).

The #125 starter rule set ships as two `VMRule`s:

| Rule                                      | Where                                                                                                                    | Fires when                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `PodCrashLooping`                         | [`values.yaml`](values.yaml)'s `extraObjects` (cluster-wide, any workload)                                               | A container restarts more than 3 times in 15m, sustained 5m.                |
| `NodeMemoryPressure` / `NodeDiskPressure` | [`values.yaml`](values.yaml)'s `extraObjects` (cluster-wide, any node)                                                   | Under 10% memory/disk free for 10m.                                         |
| `PVCNearingCapacity`                      | [`values.yaml`](values.yaml)'s `extraObjects` (cluster-wide, any PVC — covers Postgres/Redis's from `../chat-platform/`) | Over 85% used for 15m.                                                      |
| `BackendReadinessFailing`                 | `../chat-platform/templates/backend-metrics-alerts.yaml`                                                                 | The backend's `/ready` probe (see `src/Health.ts`) has been failing for 5m. |
| `BackendHighErrorRate`                    | `../chat-platform/templates/backend-metrics-alerts.yaml`                                                                 | The backend's 5xx response rate is over 5% for 5m.                          |

Pod-crash-loop/memory/disk/PVC rules aren't specific to `chat-platform`
namespace by design — they'll also catch, e.g., a crash-looping
`kube-system` pod. The backend rules are release-scoped (`.Release.Namespace`),
so they only ever match this chart's own backend Deployment.

Every alert carries a `severity` label (`critical`/`warning`) and a
`summary`/`description` annotation — `alertmanager-config`'s `route.group_by`
should include `severity` if you want to route/silence by it.

**Notification channel**: deliberately minimal per #125 — a webhook receiver
(see the `alertmanager.yaml` snippet in Installing above). Point
`webhook_configs[].url` at whatever's convenient (a self-hosted receiver, a
service like [ntfy.sh](https://ntfy.sh) or ansible-webhook, ...); Slack/
PagerDuty-style routing is a later add-on, not blocking this pass. Swap the
whole `receivers`/`route` block for Alertmanager's `email_configs` instead if
you'd rather get alerts by email — same Secret, different content.

**Verifying an alert actually fires** (per #125's acceptance criteria — do
this once after installing, on the real cluster):

```bash
kubectl scale deployment chat-platform-backend -n chat-platform --replicas=0
# wait a few minutes past the 5m `for:` on BackendReadinessFailing / the
# pod-restart window on PodCrashLooping — whichever the scale-to-zero trips
# first depends on how the remaining replicas wind down
kubectl port-forward -n observability svc/vm-stack-vmalert 8080:8080
# browse http://localhost:8080/vmalert/alerts — the rule should show "firing"
# and the configured webhook/email receiver should have gotten a notification
kubectl scale deployment chat-platform-backend -n chat-platform --replicas=2
```

## Using it

- **Grafana**: reachable at `grafana.ingress.hosts[0]` (or via the
  `port-forward` command above), logging in with the `grafana-admin` secret's
  credentials. Both the `VictoriaMetrics` and `Loki` datasources are
  provisioned automatically (`defaultDatasources`/`grafana.datasources`/
  `grafana.sidecar.datasources` in `values.yaml`) — no manual datasource
  setup needed.
- **Querying metrics**: Grafana's **Explore** view, datasource
  `VictoriaMetrics`, e.g.:
  - Node CPU: `100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`
  - Node memory used: `node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes`
  - Pod restarts: `kube_pod_container_status_restarts_total`
  - PVC usage: `kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes`
- **Querying logs**: Grafana's **Explore** view, datasource `Loki`, e.g.:
  - All backend logs: `{namespace="chat-platform", container="backend"}`
  - Backend errors only: `{namespace="chat-platform", container="backend"} |= "error"`
  - Every pod in a namespace: `{namespace="observability"}`
  - `namespace`/`pod`/`container` are the labels Alloy attaches to every log
    line (see `alloy-values.yaml`'s `discovery.relabel` block) — use the
    label browser in Explore to see what else is available on a given
    stream.
- **Backend dashboard**: a "Chat Platform - Backend" dashboard (request
  rate/latency by route, WS connections, DB/PubSub error rates) is
  pre-provisioned under the "chat-platform" folder — no import needed, see
  `../chat-platform/templates/backend-metrics-grafana-dashboard.yaml`.
- **Alerts**: `kubectl port-forward -n observability svc/vm-stack-vmalert
8080:8080` then browse `http://localhost:8080/vmalert/alerts` for current
  alert state (pending/firing), or `svc/vm-stack-vmalertmanager 9093:9093`
  and `http://localhost:9093` for Alertmanager's own UI (silences, routing).
  See [Alerting](#alerting) above for the rule set and how to verify one
  actually fires end-to-end.
