# ai-scanner Helm chart

Runs ai-scanner on Kubernetes or OpenShift. The server starts one agent pod per Scan
Attempt, in the release namespace (ADR-0007).

```sh
helm repo add ai-scanner https://gpillon.github.io/ai-scanner
helm install scanner ai-scanner/ai-scanner -n ai-scanner --create-namespace \
  --set 'models[0].id=claude-sonnet' --set 'models[0].provider=anthropic' \
  --set 'env[0].name=ANTHROPIC_API_KEY' --set 'env[0].valueFrom.secretKeyRef.name=llm-keys' \
  --set 'env[0].valueFrom.secretKeyRef.key=anthropic'
```

`models` only seeds the Model Pool on the first start. After that, manage Providers and
models from the admin UI, where API keys are stored encrypted. The NOTES printed by
`helm install` say how to reach the UI and read the tokens.

## What it creates

- **Server Deployment**, one replica with the `Recreate` strategy: the database is SQLite
  and the Scan supervisor runs in-process. The pod has two containers:
  - `server`, the API and the web UI (`/ui/`);
  - `egress-proxy`, the agents' only way out. Before each Attempt the server writes the
    proxy's allow list, the Model Pool's endpoints, into a volume the two containers share.
- **A PersistentVolumeClaim** for the data directory. Agent pods mount it too: workspace and
  skills read-only, `/output` writable. With a ReadWriteOnce volume they are scheduled on
  the server's node; with ReadWriteMany, anywhere. The claim is kept on `helm uninstall`.
- **Agent pods**, created by the server for each Attempt, not by Helm. They:
  - use a read-only root filesystem, no capabilities and seccomp `RuntimeDefault`;
  - have no ServiceAccount token and no service links;
  - get the model key from a Secret per Attempt, owned by the pod.
- **NetworkPolicies**. Agent pods reach only the egress proxy and DNS, and nothing reaches
  them. Only agent pods reach the proxy port. They need a CNI that enforces NetworkPolicy
  (OVN-Kubernetes, Calico, Cilium, ...).
- **A namespaced Role** for the server: pods, `pods/log`, secrets, and read access to
  services and persistentvolumeclaims. Nothing is cluster-scoped.

## What the server discovers by itself

`SCANNER_RUNNER` is `kubernetes` in the chart, and the server reads its own pod to find:

| | How | Override |
|---|---|---|
| Namespace | its ServiceAccount | |
| Data claim | the volume mounted at the data directory | `SCANNER_K8S_DATA_CLAIM` |
| Node pinning | the claim's access mode | `SCANNER_K8S_COLOCATE` (`auto`/`always`/`never`) |
| Agent image | its own image, `ai-scanner` → `ai-scanner-agent`, same tag | `agent.image` |
| Egress proxy | the Service selecting it with a port named `egress` | `SCANNER_K8S_EGRESS_PROXY` |
| Pull secrets, fsGroup, UID | its own pod | |

The chart detects OpenShift through `security.openshift.io` and adapts:

- the restricted SCC assigns the UID and fsGroup, where elsewhere the chart runs as the
  image's `node` user (1000);
- `expose.enabled` creates a Route there, and an Ingress elsewhere.

Set `openshift: true|false` or `expose.type: route|ingress` to force either.

## Values

See [values.yaml](values.yaml). The main ones:

| Value | Default | |
|---|---|---|
| `image.repository` / `tag` | `ghcr.io/gpillon/ai-scanner` / appVersion | server image |
| `agent.image` | derived | agent image |
| `agent.resources.limits` | `4Gi` / `2` CPU | per agent pod |
| `agent.passEnv` | `[]` | server env vars handed to agents |
| `models`, `defaultModel` | `[]` | Model Pool seed (first start only) |
| `auth.existingSecret` | generated | `SCANNER_TOKEN`, `SCANNER_ADMIN_TOKEN`, `SCANNER_SECRET_KEY` |
| `persistence.size` / `accessModes` / `storageClass` | `20Gi` / RWO | data volume |
| `scanner.*` | | concurrency, attempts, timeouts, retention |
| `networkPolicy.enabled` | `true` | |
| `expose.enabled` | `false` | expose the API and UI: a Route on OpenShift, an Ingress elsewhere (`expose.type`) |
| `expose.host`, `expose.tls`, `expose.className` | | host (required for an Ingress), TLS, ingress class |

## Release

A release is a `vX.Y.Z` tag on `main`:

```sh
make release VERSION=0.2.0       # sets the chart, appVersion and package versions, commits, tags
make release-push VERSION=0.2.0  # pushes main and the tag
```

On the tag, CI builds and pushes both images as `0.2.0`. `.github/workflows/helm-release.yml`
then lints the chart, renders it for Kubernetes and for OpenShift, and validates both with
kubeconform. Finally it adds `ai-scanner-0.2.0.tgz` to the `gh-pages` branch and merges its
entry into the existing `index.yaml`: one repository URL lists every version released so
far, and a published version is never overwritten. It also attaches the package to the
GitHub release. Changes to the chart outside a tag are linted, never published.
