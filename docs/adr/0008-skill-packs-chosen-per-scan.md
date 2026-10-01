# Admins import skills into Skill Packs; callers add packs to a Scan

A Scan Profile's skills are general, but codebases differ: a Java service benefits from skills about Spring, a Go one from skills about its standard library. Admins can now import extra skills into a **Skill Library** and group them into **Skill Packs** (for example `java`, `go`, `frontend`). A caller adds packs to a Scan by name (`skillPacks`), on top of its Scan Profile's own skills.

- **Import is an admin action** (ADR-0006 admin token). It has two paths: a zip of skill directories, extracted with the Source Archive limits, or the `skills` CLI (`skills add <source>`, npm package `skills`, pinned).
  - The CLI is third-party code that reaches the network. The server runs the pinned copy with its own Node, never `npx`. It gets a minimal environment: no server secrets, no provider keys, no Git credentials, no telemetry, a HOME of its own under the data directory, and a time limit.
  - What the CLI reports is not trusted: the skills are read back from disk and checked. That means regular files only, size and file caps, a frontmatter name matching the directory, a description, and no clash with a Scan Profile's skills.
- **Installed when imported, not when the Scan runs.** The agent container has no network apart from the model endpoints (ADR-0003), and a Report must not depend on what a repository holds on the day the Scan runs.
- **Each Scan keeps its own copy.** At submission the Scan Profile's skills and the chosen packs' skills are copied into one directory of the Scan, which the agent sees as `/skills`. Later changes to the library or the packs do not reach queued or retried Attempts. The Scan records each pack with the name and sha256 of every skill it gave, so its Report can be traced to the exact skills.
- **The prompt names the added skills** with their descriptions, so the agent knows to load them.

This refines ADR-0004. Callers still cannot supply skills; they choose among packs an admin imported.

## Considered Options

- Letting callers upload skills with the Source Archive stays rejected, for ADR-0004's reasons.
- Installing packs inside the agent container at runtime was rejected: it needs network access to arbitrary repositories from the sandbox, and makes Reports irreproducible.
- Mounting each pack as its own directory was rejected in favour of one copied directory: the agent configuration stays as it is, and a Scan is unaffected by later edits.
