# The lead agent reads no code: reviewers read, triage and report

ADR-0011 let the main agent hand the review to `reviewer` subagents, and left it free to read the code itself. On a real Scan of Node-RED with `qwen3.8-flash-next-nvfp4` it never did: it planned the reviewers, then reviewed the whole codebase alone in one session. Its context grew to about 277k tokens, the Attempt sent 25M input tokens, and a request over 1 MB was refused (`413` from the nginx in front of the model), which ended the Attempt with exit code 1 although its output was valid. A prompt asking it to delegate was not enough.

So a Scan Profile can hold the main agent, the **lead**, to coordinating, by opencode's permissions rather than by the prompt: `"leadReadsCode": false` in its `profile.json` (the security profile sets it; the default leaves the lead free, as before). The mechanism is the agent engine's, the choice and the workflow are the profile's. The lead's `read` is denied in the workspace except for manifests and READMEs (`LEAD_READABLE` in `agent-spec.ts`), and allowed in the skills and its output; its `grep` is denied; `list` and `glob` stay, for a map of the layout. Reviewers keep reading and searching everything. Path rules match the path relative to opencode's worktree, which is `/` (no git in the image), so each external directory is allowed in both forms, `skills/*` and `../skills/*`.

The security profile's `security-review` skill follows: the lead maps the codebase briefly from the layout and the manifests, then always starts reviewers, even for a small codebase (one reviewer then). Reviewers do steps 2 to 6 on their part, triage included, since only they can re-read the code, and report the Findings kept, the candidates dismissed and their notes for the Report. The lead merges them, one Finding per root cause, classifies them and writes `findings.json`. Exactly one reviewer follows data flow across the whole codebase and is never split by component, so flows from one component into another do not fall between reviewers.

Triage spread over reviewers kept too much: on the first Node-RED Scan with this split, reviewers that saw only the nodes reported the exec node running commands and the HTTP request node fetching any URL, which is what they are for. Two things bring the judgement back together. The lead writes the product's trust model in step 1 (who is trusted, what it does on purpose) and gives it to every reviewer. And after the reviewers, one more reviewer, the verifier, receives every Finding kept, re-reads its code and triages it again; its verdict is final.

## Consequences

- Each context stays the size of one part of the codebase: on the same Node-RED Scan, on a local model, reviewers started within a minute instead of never.
- Every Finding is judged twice, by its reviewer and by the verifier: the verifier adds a few minutes to each Attempt.
- A lead that tries to read code gets a refusal from the tool, not a failed Attempt; it then has to delegate.
- `LEAD_READABLE` and step 1 of the skill name the same files; changing one means changing the other.

## Considered Options

- A stronger prompt alone was rejected: the lead in the Scan above had the instruction and a plan to follow it.
- Denying the lead every read was rejected: it needs the skills' references (classification) and its own output, and the manifests make a better split than file names alone.
