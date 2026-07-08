{{/*
Chart name, used as the base for generated resource names.
*/}}
{{- define "chat-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully-qualified name for this release, so multiple installs of this chart
(e.g. two namespaces) don't collide.
*/}}
{{- define "chat-platform.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "chat-platform.labels" -}}
app.kubernetes.io/name: {{ include "chat-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
Selector labels for a given component. Call with a dict of
{ "Release" .Release "Chart" .Chart "component" "<name>" }.
*/}}
{{- define "chat-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Get-or-generate a stable secret value. If a Secret with this name already
exists in the cluster (e.g. from a previous `helm install`), reuse its value
for `key` rather than rotating it on every `helm upgrade`. Otherwise fall
back to the explicit `default` (from values.yaml), or generate a random one.
Call with a dict of { "context" . "name" <secret-name> "key" <data-key>
"default" <fallback-value> }.
*/}}
{{- define "chat-platform.secretValue" -}}
{{- $existing := lookup "v1" "Secret" .context.Release.Namespace .name -}}
{{- if and $existing (hasKey $existing.data .key) -}}
{{- index $existing.data .key | b64dec -}}
{{- else if .default -}}
{{- .default -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}

{{/*
Resolved Secret name/key for the JWT signing secret, honoring
jwt.existingSecret when set.
*/}}
{{- define "chat-platform.jwtSecretName" -}}
{{- if .Values.jwt.existingSecret -}}
{{- .Values.jwt.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "chat-platform.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "chat-platform.jwtSecretKey" -}}
{{- if .Values.jwt.existingSecret -}}
{{- .Values.jwt.existingSecretKey -}}
{{- else -}}
jwt-secret
{{- end -}}
{{- end -}}

{{/*
Resolved Secret name/key for the Postgres password, honoring
postgres.auth.existingSecret when set.
*/}}
{{- define "chat-platform.postgresSecretName" -}}
{{- if .Values.postgres.auth.existingSecret -}}
{{- .Values.postgres.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "chat-platform.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "chat-platform.postgresSecretKey" -}}
{{- if .Values.postgres.auth.existingSecret -}}
{{- .Values.postgres.auth.existingSecretKey -}}
{{- else -}}
postgres-password
{{- end -}}
{{- end -}}

{{/*
Resolved Secret name/key for the Redis password, honoring
redis.auth.existingSecret when set.
*/}}
{{- define "chat-platform.redisSecretName" -}}
{{- if .Values.redis.auth.existingSecret -}}
{{- .Values.redis.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "chat-platform.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "chat-platform.redisSecretKey" -}}
{{- if .Values.redis.auth.existingSecret -}}
{{- .Values.redis.auth.existingSecretKey -}}
{{- else -}}
redis-password
{{- end -}}
{{- end -}}
