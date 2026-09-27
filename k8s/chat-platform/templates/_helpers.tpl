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
Resolved Secret name for the in-cluster Garage (issue #424): data keys
"access-key"/"secret-key" (the S3 key pair Garage imports on boot and the
backend signs with) and "rpc-secret" (Garage's cluster RPC secret, which only
Garage itself reads).
*/}}
{{- define "chat-platform.garageSecretName" -}}
{{- required "garage.auth.existingSecret is required when garage.enabled is true — create a Secret with access-key/secret-key/rpc-secret data keys and set this to its name (see values.yaml)" .Values.garage.auth.existingSecret -}}
{{- end -}}

{{/*
Resolved Secret name holding the backend's S3-compatible credentials (issue
#221) — access key and secret key, at data keys "access-key"/"secret-key"
(unlike the single-key secrets above, since this one holds a credential
pair). When garage.enabled, that's Garage's own Secret (see
garage-deployment.yaml); when it's disabled, point backend.s3.existingSecret
at a Secret holding your managed provider's (Cloudflare R2, Backblaze B2, AWS
S3) access/secret key instead.
*/}}
{{- define "chat-platform.s3SecretName" -}}
{{- if .Values.garage.enabled -}}
{{- include "chat-platform.garageSecretName" . -}}
{{- else -}}
{{- required "backend.s3.existingSecret is required when garage.enabled is false — create a Secret with access-key/secret-key data keys holding your S3-compatible credentials and set this to its name (see values.yaml)" .Values.backend.s3.existingSecret -}}
{{- end -}}
{{- end -}}

{{/*
Resolved public endpoint for presigned attachment URLs handed to the browser
(see src/AttachmentStorage.ts's S3_PUBLIC_ENDPOINT). When garage.enabled,
this is Garage's own Ingress (see garage-ingress.yaml) if it's turned on —
Garage's internal Service address isn't reachable from a browser. Otherwise
it comes from backend.s3.publicEndpoint (a managed bucket's public endpoint,
if it differs from backend.s3.endpoint). Empty if neither applies, e.g.
garage.ingress.enabled is false — attachments then simply won't be viewable
outside the cluster.
*/}}
{{- define "chat-platform.s3PublicEndpoint" -}}
{{- if .Values.garage.enabled -}}
{{- if .Values.garage.ingress.enabled -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.garage.ingress.tls.enabled) .Values.garage.ingress.host -}}
{{- end -}}
{{- else -}}
{{- .Values.backend.s3.publicEndpoint -}}
{{- end -}}
{{- end -}}

{{/*
Shared env-var block for the S3-compatible client (see
src/AttachmentStorage.ts), used by the backend Deployment. When
garage.enabled, endpoint/bucket/region point at the in-cluster Garage;
otherwise they come from backend.s3.* (a managed bucket).
*/}}
{{- define "chat-platform.s3Env" -}}
- name: S3_ENDPOINT
  value: {{ if .Values.garage.enabled }}{{ printf "http://%s-garage:3900" (include "chat-platform.fullname" .) | quote }}{{ else }}{{ .Values.backend.s3.endpoint | quote }}{{ end }}
{{- $publicEndpoint := include "chat-platform.s3PublicEndpoint" . }}
{{- if $publicEndpoint }}
- name: S3_PUBLIC_ENDPOINT
  value: {{ $publicEndpoint | quote }}
{{- end }}
- name: S3_BUCKET_NAME
  value: {{ if .Values.garage.enabled }}{{ .Values.garage.bucketName | quote }}{{ else }}{{ .Values.backend.s3.bucketName | quote }}{{ end }}
{{- /* Garage rejects SigV4 signatures scoped to any region but its own s3_region. */}}
{{- $region := ternary .Values.garage.region .Values.backend.s3.region .Values.garage.enabled }}
{{- if $region }}
- name: S3_REGION
  value: {{ $region | quote }}
{{- end }}
- name: S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "chat-platform.s3SecretName" . }}
      key: access-key
- name: S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "chat-platform.s3SecretName" . }}
      key: secret-key
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
