# Server is a deterministic supervisor; the intelligence lives in the skills

Producing the Report and proposing Findings is the job of the agent skills. The server never judges the quality of the output. It only checks, deterministically, that the expected Artifacts exist and are well-formed: `report.md` must be present and non-empty, and `findings.json` must match the schema when the Scan Profile declares Findings. It also renders the PDF from `report.md`.

When an Attempt ends without valid Artifacts, the server starts a new Attempt Ralph-style: the same prompt runs on the same workspace, so partial work on disk carries over, with a fixed note that the previous Attempt did not complete its output. After a configurable number of Attempts (default 3), or when the Scan timeout expires, the Scan is marked `failed`.

We chose this so behaviour changes happen in skills, not server code, and so the server stays simple, predictable and testable.

## Consequences

- A `failed` Scan exposes only its failure reason. Partial Artifacts and the agent transcript are kept internally for debugging and never served to the caller: a half-written Report mistaken for a complete one is worse than no Report.
- Improving Report quality means changing skills or prompts, never adding heuristics to the server.
- A Scan Profile with a Report Template narrows this contract: the agent writes only `findings.json`, and the server fills `report.md` and the PDF from it (ADR-0005).
