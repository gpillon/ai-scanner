# One isolated container per Scan; the Source Archive is untrusted

The *meaning* of a Source Archive's contents is the caller's responsibility. Protecting ai-scanner from it is ours. Each Scan runs the agent in its own ephemeral container, never in the API process. The container's egress is limited to the configured model endpoints, the agent has no shell access, and the archive is extracted with size and file-count limits and path-traversal rejection.

The execution backend sits behind a `Runner` interface: Podman locally for the PoC, Kubernetes/OpenShift Jobs later.

## Considered Options

- Running the agent in-process or in a shared worker was rejected. A hostile archive, or an agent following instructions embedded in it, could then affect the server and other Scans.
