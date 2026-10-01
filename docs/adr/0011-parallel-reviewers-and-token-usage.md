# The agent reviews in parallel subagents, and every Attempt reports its tokens

**Parallel reviewers.** opencode's configuration defines a `reviewer` subagent, which can only read and search the workspace and the skills. The main agent may start it through the `task` tool, and may start no other subagent. Reviewers start none themselves. The security skill hands steps 2 to 5 to several reviewers started in one message: dependencies, secrets and insecure defaults; injection and data flow; access control and misuse-prone APIs; and, for a large codebase, one reviewer per component. opencode runs them at once, each in its own session. The main agent alone merges their candidates, triages them and writes the output. A small codebase is still reviewed by the main agent alone.

**Token usage.** opencode's JSON event stream reports the main session's tokens only. Its own database, in the agent's `HOME`, holds every session's totals, subagents included. `HOME` is new for each Attempt, so the sum over that database is the Attempt's usage. The agent container runs `containers/agent/usage.js` once opencode exits, keeping opencode's exit code. The script prints that sum as the transcript's last line, `{"type":"usage", ...}`. The supervisor adds each Attempt's usage to the Scan's. `GET /api/scan/<id>` and the UI show it, and the activity stream shows each Attempt's total.

## Consequences

- Usage is about running the service, not about the code reviewed: it is never in the Report or the Findings.
- A transcript without a usage line adds nothing: an agent image older than the server, or an Attempt killed before opencode exits (a timeout, a stopped Scan). Usage is then a lower bound.
- Reviewers use the Scan's model. Parallel reviewers raise the load on the model at once, though rarely the total tokens: each reads only its part.
- The usage script depends on opencode's database schema (`session` table, `tokens_*` columns). An opencode upgrade that changes it yields no usage line, never a failed Attempt.

## Considered Options

- Summing the stream's `step_finish` events was rejected: it misses every subagent.
- `opencode stats` was rejected: it prints rounded, formatted figures ("1.7K").
