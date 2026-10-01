# One isolated container per Scan; the Source Archive is untrusted

The *meaning* of a Source Archive's contents is the caller's responsibility. Protecting ai-scanner from it is ours. Each Scan runs the agent in its own ephemeral container, never in the API process. The container's egress is limited to the configured model endpoints, the agent has no shell access, and the archive is extracted with size and file-count limits and path-traversal rejection.

The execution backend sits behind a `Runner` interface: Podman locally for the PoC, Kubernetes/OpenShift Jobs later.

Each Attempt gets an egress proxy of its own, started with it and removed with it, which lets through only the endpoint of its Scan's model. The allow list is fixed when the proxy starts. With Podman, the agent's only network is an internal one it shares with that proxy alone, so Scans cannot reach each other either. In Kubernetes the proxy is a separate pod with per-Attempt NetworkPolicies (ADR-0007). A second container in the agent's pod would share its network, and NetworkPolicies cannot tell the two apart. Each server instance labels its containers with an id derived from its data directory, and cleans up only its own: two instances on one host leave each other alone.

## Considered Options

- Running the agent in-process or in a shared worker was rejected. A hostile archive, or an agent following instructions embedded in it, could then affect the server and other Scans.
- One proxy shared by every Attempt was used first. It had to let through every model's endpoint, and its allow list changed at runtime. Agents shared a network. And the last server instance to start on a host took the proxy over from the others.
