# Sources and changes

This skill is adapted from two MIT-licensed works. Their license texts are in `LICENSE`.

## github/awesome-copilot: `skills/security-review`

- Source: https://github.com/github/awesome-copilot/tree/7e375eac04fa04f291859ca962a4d8a3bb8b7564/skills/security-review
- Copyright GitHub, Inc. MIT License.
- `references/language-patterns.md`, `references/secret-patterns.md`,
  `references/vuln-categories.md` and `references/vulnerable-packages.md` are vendored unchanged.
- `SKILL.md` keeps the upstream workflow (scope, dependency audit, secrets scan, deep scan,
  cross-file data flow, self-verification, report) and severity scale, rewritten for a one-shot,
  read-only, offline Scan: no patch proposals or human approval step, output to a single
  `findings.json` holding the Findings and the data of the server's Report template, and
  hand-offs to the `insecure-defaults`, `sharp-edges`
  and `vulnerability-triage-brocards` skills. `references/report-format.md` is not vendored; the
  Report format is defined in `SKILL.md`.

## anthropics/claude-code-security-review: `.claude/commands/security-review.md`

- Source: https://github.com/anthropics/claude-code-security-review/blob/0c6a49f1fa56a1d472575da86a94dbc1edb78eda/.claude/commands/security-review.md
- Copyright (c) 2025 Anthropic. MIT License.
- `references/false-positives.md` is its "False positive filtering" section, adapted: applied to a
  whole codebase instead of a pull-request diff; the exclusions of "secrets or credentials stored
  on disk" and "outdated third-party libraries" are removed (this review reports both); the
  "local network" note became a precedent; sub-task instructions are dropped; the confidence
  threshold maps onto the Findings' `confidence` field.
