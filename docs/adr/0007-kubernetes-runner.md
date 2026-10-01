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
- **Egress through a sidecar.** The egress proxy is a second container of the server pod, running the same image. The server writes the allow list into an emptyDir the two containers share, as the Podman Runner does with its directory (ADR-0006). The proxy rereads it on every connection, so a change applies at the next Attempt. A ConfigMap was ruled out because the kubelet takes up to a minute to propagate it; a control endpoint was ruled out because agents could reach it. NetworkPolicies:
  - let agent pods reach only the proxy port and DNS;
  - let nothing reach the agent pods;
  - let only agent pods reach the proxy port.

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
- **The proxy as a Deployment of its own, with its allow list in a ConfigMap,** was rejected for the propagation delay above. It would also add an image and a Deployment for something the server already ships.
- **A Job per Attempt** was rejected: it brings retries, back-off and history that compete with the supervisor's.
