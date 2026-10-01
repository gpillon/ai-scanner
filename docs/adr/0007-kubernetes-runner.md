# On Kubernetes, each Attempt is a pod in the server's namespace

The Kubernetes Runner runs each Attempt as an agent pod, in the namespace where the server runs. It is the second adapter behind the `Runner` interface (ADR-0003). `SCANNER_RUNNER=auto`, the default, picks it when the server finds its own ServiceAccount token, and picks Podman elsewhere. The Helm chart (`charts/ai-scanner`) installs it on Kubernetes and on OpenShift, which it detects from the cluster's APIs.

What the Runner needs, it discovers from the server's own pod rather than from configuration:
- the namespace;
- the PersistentVolumeClaim mounted at the data directory, and the node, when that claim is ReadWriteOnce;
- the agent image, derived from the server's image;
- the image pull secrets and fsGroup;
- the Service exposing the egress proxy.

Each of these can still be set explicitly.

- **Data on the shared claim.** The agent pod mounts the server's data claim through subPaths:
  - the workspace and the skills read-only;
  - its `/output` writable.

  Nothing is copied over the API, and a ReadWriteOnce volume works by pinning agent pods to the server's node. The pod runs as the server's UID, so each side can read what the other writes. The profile skills live in the server image, so they are copied onto the volume first. A Scan's own skills snapshot is already there.
- **A Pod, not a Job.** The supervisor owns retries and timeouts (ADR-0001), so a Job's controller would only duplicate them. Pods have `restartPolicy: Never` and an `activeDeadlineSeconds` backstop, and they are owned by the server pod, so the cluster removes them with it. At startup the server deletes the agent pods and Secrets its instance left behind.
- **Hardened pods.** Agent pods have:
  - a read-only root filesystem, no capabilities, seccomp `RuntimeDefault` and resource limits;
  - no ServiceAccount token and no service links.

  The model key goes into a Secret per Attempt, owned by its pod, and never into the pod spec. A pod that can never start (an image pull error, a configuration error, a node that cannot schedule it) ends the Attempt at once, without waiting for its timeout.
- **An egress proxy per Attempt.** Each Attempt gets its own proxy pod, running the server's image. Its allow list is only the Scan's model endpoint (`AttemptRequest.modelEgress`), fixed at start: no file, no reload, no control endpoint. Each agent can reach its own model, and no other in the pool. NetworkPolicies:
  - The chart denies agent pods all ingress and all egress, DNS included. Nothing may reach proxy pods.
  - For each Attempt, the server adds two policies before starting either pod: its agent may reach its proxy's port, and only that agent may reach that proxy.
  - Policies only add up, so an agent can never reach another Attempt's proxy.
  - The agent is given the proxy's pod IP, so it needs no DNS at all, which also closes DNS as a way out.
  - Proxy pods keep their egress, to reach the model.

  The proxy is a pod of its own, not a container in the agent pod: containers share their pod's network, so the agent could bypass a proxy beside it, and redirecting its traffic would need `NET_ADMIN`.

## Consequences

- One server replica (`Recreate`): SQLite, the in-process supervisor and the shared volume all assume it.
- The server's Role can create pods and read the namespace's Secrets. Install it in a namespace of its own, so it can reach no other application's Secrets.
  - On vanilla Kubernetes, also enforce the `restricted` Pod Security Standard on that namespace (`pod-security.kubernetes.io/enforce: restricted`).
  - On OpenShift, the restricted SCC already applies.
- The isolation of agents relies on NetworkPolicy, so the cluster's CNI must enforce it.
- With a ReadWriteOnce volume, every agent pod runs on the server's node, which bounds concurrency to that node's capacity. A ReadWriteMany volume lifts this.
- The chart generates the tokens with `lookup`, keeping them across upgrades. Tools that render without a cluster (`helm template`, GitOps) would regenerate them on every render: use `auth.existingSecret` there.

## Considered Options

- **Copying the workspace into the pod over the API** (exec and tar, or an init container downloading from the server) was rejected. It needs either a writable channel from agent pods back to the server, or exec rights and a keep-alive container. A shared volume needs neither.
- **One shared proxy for all Attempts** (a sidecar of the server, rereading an allow list the server rewrites) came first. It was replaced because every agent could then reach every model in the pool. A shared proxy as a Deployment with its allow list in a ConfigMap was worse still: the kubelet takes up to a minute to propagate a change.
- **A Job per Attempt** was rejected: it brings retries, back-off and history that compete with the supervisor's.
