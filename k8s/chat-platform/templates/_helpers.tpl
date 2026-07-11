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
Resolved Secret name/key for the JWT signing secret. Its data key is
assumed to match the Secret's own name (see values.yaml's jwt.existingSecret).
*/}}
{{- define "chat-platform.jwtSecretName" -}}
{{- required "jwt.existingSecret is required — create a Secret holding the JWT signing secret and set this to its name (see values.yaml)" .Values.jwt.existingSecret -}}
{{- end -}}

{{- define "chat-platform.jwtSecretKey" -}}
{{- include "chat-platform.jwtSecretName" . -}}
{{- end -}}

{{/*
Resolved Secret name/key for the Postgres password. Its data key is assumed
to match the Secret's own name (see values.yaml's postgres.auth.existingSecret).
*/}}
{{- define "chat-platform.postgresSecretName" -}}
{{- required "postgres.auth.existingSecret is required — create a Secret holding the Postgres password and set this to its name (see values.yaml)" .Values.postgres.auth.existingSecret -}}
{{- end -}}

{{- define "chat-platform.postgresSecretKey" -}}
{{- include "chat-platform.postgresSecretName" . -}}
{{- end -}}

{{/*
Resolved Secret name/key for the Redis password. Its data key is assumed
to match the Secret's own name (see values.yaml's redis.auth.existingSecret).
*/}}
{{- define "chat-platform.redisSecretName" -}}
{{- required "redis.auth.existingSecret is required — create a Secret holding the Redis password and set this to its name (see values.yaml)" .Values.redis.auth.existingSecret -}}
{{- end -}}

{{- define "chat-platform.redisSecretKey" -}}
{{- include "chat-platform.redisSecretName" . -}}
{{- end -}}

{{/*
Shared env-var block for connecting to Postgres via DATABASE_URL. Used by
both the backend Deployment and the migration Job so the connection string
can't silently drift between the two — see issue #178.
*/}}
{{- define "chat-platform.postgresEnv" -}}
- name: POSTGRES_USER
  value: {{ .Values.postgres.auth.username | quote }}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "chat-platform.postgresSecretName" . }}
      key: {{ include "chat-platform.postgresSecretKey" . }}
- name: POSTGRES_DB
  value: {{ .Values.postgres.auth.database | quote }}
# Composed from the vars above via Kubernetes' `$(VAR)` env
# substitution (supported for `env[].value`, referencing earlier
# entries in this same list) — src/Db.ts just wants one
# connection-string env var.
- name: DATABASE_URL
  value: "postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@{{ include "chat-platform.fullname" . }}-postgres:5432/$(POSTGRES_DB)"
{{- end -}}
