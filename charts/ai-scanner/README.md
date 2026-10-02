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
  and the Scan supervisor runs in-process. It serves the API and the web UI (`/ui/`).
- **A PersistentVolumeClaim** for the data directory. Agent pods mount it too: workspace and
  skills read-only, `/output` writable. With a ReadWriteOnce volume they are scheduled on
  the server's node; with ReadWriteMany, anywhere. The claim is kept on `helm uninstall`.
- **Agent pods**, created by the server for each Attempt, not by Helm. They:
  - use a read-only root filesystem, no capabilities and seccomp `RuntimeDefault`;
  - have no ServiceAccount token and no service links;
  - get the model key from a Secret per Attempt, owned by the pod.
- **An egress proxy pod per Attempt**, also created by the server. It runs the server image
  and lets through only that Scan's model endpoint, plus the hosts its Scan Profile lists in
  `egressAllow`. The agent reaches it by IP.
- **A Preparation pod per Scan**, for a Scan Profile with a `prepare/run.sh` (ADR-0015): the
  agent image running that script once before the first Attempt, held like an agent pod,
  with its own proxy.
- **Agent image variants**. A Scan Profile may run its Preparation and Attempts in a variant
  of the agent image, e.g. `"agentImage": "full"` for `ai-scanner-agent-full` (ADR-0016).
  CI publishes `-full` beside the agent image at every release; a variant you build yourself
  must be pushed next to the agent image, with the same tag, where the cluster can pull it.
  A Scan whose image cannot be pulled fails at once, saying which image.
- **NetworkPolicies**. The chart denies agent pods everything, DNS included, and keeps proxy
  pods unreachable. For each Attempt the server adds a pair: its agent may reach its own
  proxy, and nothing else may. They need a CNI that enforces NetworkPolicy (OVN-Kubernetes,
  Calico, Cilium, ...).
- **A namespaced Role** for the server: pods, `pods/log`, secrets, networkpolicies, and
  read access to persistentvolumeclaims. Nothing is cluster-scoped.

## What the server discovers by itself

`SCANNER_RUNNER` is `kubernetes` in the chart, and the server reads its own pod to find:

| | How | Override |
|---|---|---|
| Namespace | its ServiceAccount | |
| Data claim | the volume mounted at the data directory | `SCANNER_K8S_DATA_CLAIM` |
| Node pinning | the claim's access mode | `SCANNER_K8S_COLOCATE` (`auto`/`always`/`never`) |
| Agent image | its own image, `ai-scanner` → `ai-scanner-agent`, same tag | `agent.image` |
| A profile's agent image variant | the agent image, `ai-scanner-agent` → `ai-scanner-agent-<variant>`, same tag (ADR-0016) | follows `agent.image` |
| Proxy image | its own image, which ships the proxy | `SCANNER_K8S_PROXY_IMAGE` |
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
kubeconform. Finally it adds `ai-scanner-0.2.0.tgz` to the `gh-pages` branch, the archive of
every release, merges its entry into the existing `index.yaml`, and deploys the archive to
GitHub Pages (Settings > Pages > Source: GitHub Actions). One repository URL lists every
version released so far, and a published version is never overwritten. It also attaches the
package to the GitHub release. Changes to the chart outside a tag are linted, never published.
