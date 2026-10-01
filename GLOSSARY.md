# ai-scanner

A service that receives source code over an API, runs an AI coding agent on it with a chosen analysis, and returns a report to the caller.

## Language

**Scan**:
One analysis of one uploaded codebase, from submission until its Artifacts are available.
_Avoid_: Job, Run, Analysis, Task

**Source Archive**:
The zip file of source code the caller uploads to start a Scan.
_Avoid_: Upload, payload, package, zip

**Source Repository**:
A Git repository, with an optional branch or tag, that a caller names instead of uploading a Source Archive; the server checks out one commit of it (ADR-0010).
_Avoid_: Repo source, remote, checkout

**Scan Profile**:
A named kind of analysis a caller can request, bundling the agent skills and instructions that produce its Report.
_Avoid_: Skill, scan type, analysis type

**Skill Pack**:
A named group of agent skills that an admin imports, and a caller can add to a Scan on top of its Scan Profile's own skills (ADR-0008).
_Avoid_: Skill group, plugin, extension, bundle

**Attempt**:
One execution of the agent within a Scan; a Scan retries with a new Attempt when an Attempt ends without valid Artifacts.
_Avoid_: Retry, iteration, run

**Warm-up**:
The one-token completion the server asks a Scan's model for before its first Attempt, waiting while the model scales up; the Scan is `warming` meanwhile (ADR-0009).
_Avoid_: Ping, health check, preflight

**Artifact**:
A file produced by a Scan and stored for the caller to retrieve.
_Avoid_: Output, result file

**Report**:
The Artifact that is the Scan's deliverable to the caller, rendered in one or more formats (e.g. Markdown, PDF).
_Avoid_: Result, deliverable, document

**Report Template**:
The fixed layout of a Scan Profile's Report, which the server fills from the data the agent writes in `findings.json` (ADR-0005).
_Avoid_: Report format, skeleton

**Finding**:
A single issue identified by a Scan, in a structured form shared by all Scan Profiles that produce Findings.
_Avoid_: Issue, vulnerability, defect

### Models

**Model Pool**:
The set of LLM models an admin allows for Scans, each served by a Provider (ADR-0006).
_Avoid_: Model list

**Provider**:
An LLM API that serves Model Pool models, with how to reach it and its API key; its kind (`anthropic`, `openai-compatible`, ...) says how to talk to it.
_Avoid_: Backend, endpoint, vendor

**Default Model**:
The Model Pool entry a Scan uses when the caller does not ask for a specific one.
_Avoid_: Fallback model
