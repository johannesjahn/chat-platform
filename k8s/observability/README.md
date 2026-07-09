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
repo, declared in [`helmfile.yaml`](helmfile.yaml) with
[`values.yaml`](values.yaml) here as the checked-in override file. Helmfile
(rather than a plain `helm install`/`upgrade`, as `../chat-platform/`
documents) makes this stack syncable declaratively, including from ArgoCD —
see [Deploying via ArgoCD](#deploying-via-argocd) below.

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

Requires the [`helmfile`](https://helmfile.readthedocs.io/) CLI (which
shells out to `helm` — no separate `helm repo add` needed, `helmfile.yaml`'s
`repositories:` block handles that).

```bash
kubectl create secret generic grafana-admin -n observability --create-namespace \
  --from-literal=admin-user=admin \
  --from-literal=admin-password="$(openssl rand -base64 24)"

helmfile apply
```

(same `existingSecret` reasoning as `../chat-platform/`'s Postgres/Redis/JWT
secrets — see `../README.md` — so re-running `helmfile apply` never rotates
or regenerates the Grafana admin password out from under you.)

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

`helmfile.yaml`'s `releases[].version` pins the `victoria-metrics-k8s-stack`
chart version — bump it deliberately (check the [upstream
Chart.yaml](https://github.com/VictoriaMetrics/helm-charts/blob/master/charts/victoria-metrics-k8s-stack/Chart.yaml)
for the latest version and changelog first) rather than floating on
whatever `helm repo update` last cached, so renders stay reproducible across
machines and ArgoCD syncs.

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
   (as `argo-cd` chart values, if that's how ArgoCD is installed):

   ```yaml
   repoServer:
     extraContainers:
       - name: helmfile
         image: ghcr.io/helmfile/helmfile:v0.157.0
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
