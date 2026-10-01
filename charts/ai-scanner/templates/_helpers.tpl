{{- define "ai-scanner.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ai-scanner.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else if contains (include "ai-scanner.name" .) .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "ai-scanner.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "ai-scanner.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
The name and instance labels agent pods carry too: the Runner copies `instance` from the
server pod, and the NetworkPolicies select on both.
*/}}
{{- define "ai-scanner.selectorLabels" -}}
app.kubernetes.io/name: ai-scanner
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ai-scanner.labels" -}}
helm.sh/chart: {{ include "ai-scanner.chart" . }}
{{ include "ai-scanner.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "ai-scanner.serverSelectorLabels" -}}
{{ include "ai-scanner.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end }}

{{- define "ai-scanner.agentSelectorLabels" -}}
{{ include "ai-scanner.selectorLabels" . }}
app.kubernetes.io/component: agent
{{- end }}

{{- define "ai-scanner.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ai-scanner.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "ai-scanner.agentServiceAccountName" -}}
{{- if .Values.agent.serviceAccount.create }}
{{- default (printf "%s-agent" (include "ai-scanner.fullname" .)) .Values.agent.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.agent.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "ai-scanner.secretName" -}}
{{- default (include "ai-scanner.fullname" .) .Values.auth.existingSecret }}
{{- end }}

{{- define "ai-scanner.claimName" -}}
{{- default (printf "%s-data" (include "ai-scanner.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}

{{- define "ai-scanner.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* `route` or `ingress`: from expose.type, or with `auto`, a Route on OpenShift and an Ingress elsewhere. */}}
{{- define "ai-scanner.exposeKind" -}}
{{- $type := toString .Values.expose.type }}
{{- if eq $type "auto" }}
{{- ternary "route" "ingress" (and (eq (include "ai-scanner.openshift" .) "true") (.Capabilities.APIVersions.Has "route.openshift.io/v1")) }}
{{- else if has $type (list "route" "ingress") }}
{{- $type }}
{{- else }}
{{- fail (printf "expose.type must be auto, route or ingress: %s" $type) }}
{{- end }}
{{- end }}

{{/* "true" on OpenShift: from `openshift: true|false`, or detected with `auto`. */}}
{{- define "ai-scanner.openshift" -}}
{{- if eq (toString .Values.openshift) "auto" }}
{{- .Capabilities.APIVersions.Has "security.openshift.io/v1" }}
{{- else }}
{{- toString .Values.openshift }}
{{- end }}
{{- end }}
