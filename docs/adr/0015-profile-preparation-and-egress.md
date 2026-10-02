# A Scan Profile can prepare the code with a script, and name the hosts its Scans reach

Some analyses need deterministic work before a model is useful: unpacking binary archives, listing the libraries they bundle, counting files, looking versions up in a public registry. The agent cannot do it: it has no shell (ADR-0003), and ADR-0005 says such work belongs to the server. A model doing it by reading would be slow, costly and not repeatable.

So a Scan Profile can bring a **Preparation**: a `prepare/` directory with a `run.sh` script, and any files it needs beside it. The server runs it once per Scan, before the first Attempt, without a model, and the agent reads what it wrote.

- **Once per Scan, before the warm-up.** It runs after the Source Archive is extracted (or the repository copied), and before the model warm-up (ADR-0009). A long Preparation after the warm-up would leave a scale-to-zero model idle until it scaled down again. Attempts do not repeat it: they all read the same output.
- **The agent's isolation, with the script as command.** The Runner starts it like an Attempt: the agent image, a read-only root filesystem, no capabilities, a small `/tmp` and home, its own egress proxy, and with Kubernetes the agent labels, so the same NetworkPolicies hold it. The command is `bash /prepare/run.sh`, through bash, since a file copied onto the data volume may lose its exec bit. It sees:
  - `/workspace`, the code, read-only;
  - `/prepared`, empty and writable: its output;
  - `/prepare`, the profile's `prepare/` directory, read-only;
  - `SCANNER_WORKSPACE` and `SCANNER_PREPARED`, and its proxy in `HTTPS_PROXY`. No model, no key, no secret of any kind.
- **The agent reads it, read-only.** Every Attempt mounts the output at `/prepared`, read-only, and opencode's permissions let every agent read it, the lead included when the profile sets `leadReadsCode: false` (ADR-0012). It is the profile's prompt and skills that tell the agent what is there.
- **Its own timeout, and a clear failure.** `prepareTimeoutMinutes` in `profile.json` bounds it, 30 by default; the Scan timeout starts later, after the warm-up. A non-zero exit, a timeout, or a container that cannot start fails the Scan at once, without any Attempt: `Preparation failed: it exited with code 3: <the last line it printed>`. The script's output is kept with the Scan, like a transcript, and never served.
- **Visible.** The Scan is `running` with no Attempt meanwhile; its start and end, or its failure, go to the log the warm-up writes, which the activity stream shows as Attempt 0 `log` events. With a warm-up, the Scan turns `warming` once the Preparation is done.
- **Gone with the code.** Its output derives from the caller's code, so it is removed with the workspace when the Scan ends (ADR-0003). A Scan interrupted by a restart while preparing goes back to the queue and prepares again from an empty directory.

A Scan Profile can also name hosts its Scans may reach besides the model: `"egressAllow": ["packages.example.org"]` in `profile.json`, a host name with an optional port (443 when none). Each Scan of the profile adds them to its proxies' allow list, in the Preparation and in every Attempt. Proxies are per Attempt, with their allow list fixed at start (ADR-0003, ADR-0007), so a profile's hosts reach only its own Scans, never another profile's running at the same time.

This amends ADR-0003 and ADR-0007, where an Attempt's proxy lets through its model's endpoint and nothing else: it now also lets through its profile's hosts. They serve the Preparation's script: the agent itself still fetches nothing, as opencode denies it every command and web tool.

## Consequences

- The agent image holds only what opencode needs, so a script has bash, coreutils and Node. A profile whose script needs more runs in a variant of the agent image that adds it, such as `full` (ADR-0016).
- A Preparation runs code from the profile, which the server owns (ADR-0004), on code from the caller, which it does not. It is held like an agent for that reason, and its scratch work must fit in its small `/tmp` or go under `/prepared` and be removed before it exits, since the agent sees everything left there.
- A host in `egressAllow` is a way out for whatever runs in the Scan. Name only hosts the analysis needs, and prefer read-only public services.
- With Podman, its container is named `<instance>-<scan>-prep`; on Kubernetes, its pod `ai-scanner-<hash>-prep`, with a container named `preparation`.

## Considered Options

- **A state of its own (`preparing`)** was rejected for now: every client that lists active states would need it, and the activity stream already shows what happens. `running` with no Attempt is what a Scan shows between its claim and its first Attempt anyway.
- **Running it in the server process** was rejected: the script handles the caller's untrusted archives (ADR-0003).
- **A dedicated image for every Preparation** was rejected: a Preparation runs in the image of its profile's Attempts, the agent image or the variant its profile names (ADR-0016).
- **Letting the agent run the scripts** was rejected: the agent has no shell, and giving it one would open every other command too.
