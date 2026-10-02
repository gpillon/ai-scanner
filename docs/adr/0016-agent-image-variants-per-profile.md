# A Scan Profile can run in a variant of the agent image

A Preparation script (ADR-0015) needs tools: an archive tool, a scripting language, a JSON or HTTP client. Putting every tool any profile needs into the agent image would grow it for every Scan, and widen what a compromised Attempt finds at hand, for profiles that use none of them. So the agent image stays as it is, with only what opencode needs, and a Scan Profile can ask for a **variant** of it instead: `"agentImage": "full"` in its `profile.json`.

- **A variant is a name, not an image reference.** The server resolves it from its own agent image: `registry/org/ai-scanner-agent:1.2.3` gives `registry/org/ai-scanner-agent-full:1.2.3`, same registry, same tag. So one `profile.json` works with Podman (`localhost/…:latest`), on Kubernetes (where the agent image is derived from the server's, ADR-0007) and at every release tag, and the variant always carries the same opencode as the agent image. A profile cannot point Scans at an arbitrary registry; an operator chooses where images come from, once, with the agent image setting.
- **For the whole Scan.** The profile's Preparation and its Attempts all run in the variant. The agent gains nothing from the extra tools, as opencode denies it every command; one image per profile keeps a single thing to build, pull and reason about.
- **A variant extends the agent image.** Its Containerfile starts `FROM` the agent image (`ARG BASE_IMAGE`) and adds layers: no second copy of opencode, and the Runners' command is the base image's. `containers/agent-full/` is the one shipped, with `unzip`, `python3`, `perl`, `jq`, `curl` and `binutils`. It switches to root to install packages and back to the base image's user (`ARG BASE_USER`), since the Runners, not the image, choose who the container runs as.
- **Checked at start-up, and at use.** A name that cannot be part of an image repository stops the server at start-up. An image that cannot be had fails the Scan at once, without further Attempts, with a reason naming it: Podman pulls it unless the host has it; on Kubernetes the pod's image pull error ends it. An agent image named by digest has no variants, since a variant's digest cannot be derived from it; that fails the Scan too.
- **Built and published with the agent image.** `make agent-full-image` builds it on top of `make agent-image`. CI builds it after the agent image, on the agent image pushed by the same commit, and publishes it with the same tags, so a Kubernetes deployment finds `-full` beside `-agent` at every release.

## Consequences

- An operator who adds a variant builds and pushes it next to the agent image, with the same tag. A variant missing from the registry only shows when a Scan of its profile runs.
- Variants are the operator's to define: a `containers/agent-<name>/Containerfile` built `FROM` the agent image. A profile naming one the operator has not built fails its Scans, with a reason naming the image.
- The extra tools are in the Attempt's container too, though the agent cannot run them.

## Considered Options

- **Adding the tools to the agent image** was the first version: simplest, but every Scan pays for them, and the agent image is the one thing ADR-0003 wants minimal.
- **A full image reference in `profile.json`** was rejected: the profile would pin a registry and a tag, so it would break at the next release, differ between Podman and Kubernetes, and let a profile pull code from anywhere.
- **An image for the Preparation only**, with Attempts in the agent image, was rejected: two images per profile, for no gain, as the agent cannot run the tools either way.
- **A server setting mapping variant names to images** was left out for now: deriving the name covers Podman, Kubernetes and releases, and can be overridden later without changing profiles.
