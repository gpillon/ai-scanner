# Writing a Scan Profile

A Scan Profile is a directory under `profiles/` (or `SCANNER_PROFILES_DIR`). The server reads every profile once, at start-up, and refuses to start when one is broken: restart it after a change. Profiles are the server's, never the caller's (ADR-0004).

```
profiles/<name>/
  profile.json   what the profile is, and what its Scans may do
  prompt.md      the agent's instructions
  skills/        agent skills, one <skill>/SKILL.md each (optional)
  report/        a Report Template, filled from findings.json (optional, ADR-0005)
  prepare/       a Preparation: run.sh and what it needs (optional, ADR-0015)
```

## `profile.json`

| Field | Default | Meaning |
|---|---|---|
| `name` | required | The name callers pass as `profile`. |
| `description` | required | Shown by `GET /api/profiles` and in the UI. |
| `producesFindings` | `false` | The agent writes `findings.json`. Required with `report/`. |
| `leadReadsCode` | `true` | `false`: the main agent only coordinates `reviewer` subagents, which read the code (ADR-0012). |
| `prepareTimeoutMinutes` | `30` | How long the Preparation may run. Only with `prepare/run.sh`. |
| `egressAllow` | `[]` | Hosts the Scan's proxies let through besides the model: `"host"` (port 443) or `"host:port"`. |
| `agentImage` | none | A variant of the agent image the Preparation and the Attempts run in, e.g. `"full"` (ADR-0016). |

## The Report Template

With a `report/` directory the agent writes only `/output/findings.json`, and the server fills `report.md` and `report.pdf` from it (ADR-0005):

```
report/
  schema.json      JSON Schema of findings.json, given to the agent in the prompt; it must allow the
                   shared Findings ({"findings": [...]}, possibly empty)
  report.md.hbs    Handlebars template of report.md
  report.typ       Typst template of report.pdf
  fonts/           the fonts report.typ names (optional)
```

Both templates render the same view: the server's own fields (`scan`, `risk`, `counts`, `findings` with their IDs and code excerpts, `summary`, `scope`...) and `data`, the agent's `findings.json` as it wrote it, valid against `schema.json`. A profile whose Report is not a list of Findings renders its own fields from `data`, with `"findings": []`. In Typst the view is `json(bytes(sys.inputs.data))`; in Handlebars, escape the agent's text with the `cell`, `code`, `block` and `verbatim` helpers, as it comes from a model that read untrusted input. A template computes what the agent should not decide, such as totals.

## The Preparation

A Preparation is deterministic work done before the agent starts: unpacking archives, extracting metadata, looking things up. The agent cannot do it, as it has no shell. The server runs `prepare/run.sh` once per Scan, after unpacking the code and before the model warm-up, in a container isolated like the agent's but without a model.

What the script gets:

| | |
|---|---|
| Command | `bash /prepare/run.sh`, in `/prepared`. Do not rely on the exec bit of any file. |
| `/workspace` | The caller's code, read-only: the Source Archive extracted one level (archives inside it stay files), or the repository's checkout. |
| `/prepared` | Empty and writable: the script's output. |
| `/prepare` | The profile's `prepare/` directory, read-only. |
| `/tmp`, `$HOME` | 512 MB each, in memory. Larger scratch work goes under `/prepared` and must be removed before exiting: the agent sees everything left there. |
| Environment | `SCANNER_WORKSPACE=/workspace`, `SCANNER_PREPARED=/prepared`, and `HTTPS_PROXY`/`HTTP_PROXY` (and lower-case). No model, no key, no secret. |
| Network | Only through the proxy, which lets through only `egressAllow`. On Kubernetes there is no DNS in the pod: tools must use the proxy (`curl` and Python's `urllib` read the variables). |
| User | Not root on Kubernetes (the server's uid); rootless Podman maps root to the server's user. Root filesystem read-only, no capabilities. |
| Tools | Those of the image: the agent image has bash, coreutils and Node; the `full` variant adds `unzip`, `python3`, `perl`, `jq`, `curl` and `binutils`. |

Then:

- **Exit 0**: every Attempt mounts `/prepared` read-only at `/prepared`, and every agent may read it, the lead included. Say in `prompt.md` (or a skill) what is there.
- **Non-zero exit, timeout, or a container that cannot start**: the Scan fails at once, without any Attempt. Its failure reason ends with the last non-empty line the script printed, so make that line say what went wrong, briefly, and keep secrets out of it.
- Everything the script prints is kept with the Scan for debugging (`scans/<id>/preparation.log`), never served. The Scan's activity shows when the Preparation starts and ends.
- Its output is deleted with the code when the Scan ends. A restart during a Preparation runs it again from an empty `/prepared`.

Write the files with LF line ends: bash fails on CRLF. Merge stderr into stdout (`exec 2>&1`) so the last line is the error.

### Example

A profile that counts what each uploaded zip holds, and lets the agent read the inventory. With `"agentImage": "full"` for `unzip` and `jq`:

```bash
#!/usr/bin/env bash
# profiles/inventory/prepare/run.sh
set -euo pipefail
exec 2>&1

shopt -s nullglob
archives=("$SCANNER_WORKSPACE"/*.zip)
if [ ${#archives[@]} -eq 0 ]; then
  echo "No .zip archive at the top of the upload"
  exit 1
fi

for archive in "${archives[@]}"; do
  name=$(basename "$archive" .zip)
  unzip -Z1 "$archive" | jq -R . | jq -s --arg name "$name" '{archive: $name, entries: length, files: .}' \
    > "$SCANNER_PREPARED/$name.json"
  echo "Listed $name"
done
```

And in `prompt.md`: "The inventory of each archive is in `/prepared/<archive>.json` (read-only): read it rather than `/workspace`."

## Agent image variants

The agent image holds only what opencode needs. A profile that needs more names a variant with `agentImage`; the server runs its Preparation and Attempts in the agent image's repository with `-<variant>` added, same registry and tag:

| Agent image | `"agentImage": "full"` runs |
|---|---|
| `localhost/ai-scanner-agent:latest` | `localhost/ai-scanner-agent-full:latest` |
| `ghcr.io/acme/ai-scanner-agent:1.2.3` | `ghcr.io/acme/ai-scanner-agent-full:1.2.3` |

`full` ships with ai-scanner (`containers/agent-full/`), and CI publishes it with every release. To make another variant, say `docs`, add a Containerfile that starts from the agent image and only adds layers:

```dockerfile
# containers/agent-docs/Containerfile
ARG BASE_IMAGE=localhost/ai-scanner-agent:latest
FROM ${BASE_IMAGE}
ARG BASE_USER=root
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends pandoc \
 && rm -rf /var/lib/apt/lists/*
USER ${BASE_USER}
```

Build it from the agent image of the same version, and give it the same tag:

```sh
make agent-image                               # localhost/ai-scanner-agent:latest
podman build --build-arg BASE_IMAGE=localhost/ai-scanner-agent:latest \
  -t localhost/ai-scanner-agent-docs:latest containers/agent-docs
```

On Kubernetes, push it next to the agent image the server uses (`agent.image` in the chart, or the server's image with `-agent`), same tag, where the cluster can pull it:

```sh
podman build --build-arg BASE_IMAGE=registry.example.com/team/ai-scanner-agent:1.2.3 \
  -t registry.example.com/team/ai-scanner-agent-docs:1.2.3 containers/agent-docs
podman push registry.example.com/team/ai-scanner-agent-docs:1.2.3
```

A Scan whose image cannot be had (not built, not pushed, or an agent image named by digest) fails at once, with a reason naming the image. Keep variants small: whatever they add is also in every Attempt of the profile, though the agent cannot run it.
