# Source and changes

Adapted from **Trail of Bits Skills**, `plugins/insecure-defaults`:
https://github.com/trailofbits/skills/tree/82fe8226252622fa807643bdca1710901198553a/plugins/insecure-defaults

Copyright Trail of Bits. Licensed under the Creative Commons Attribution-ShareAlike 4.0
International License (CC BY-SA 4.0), text in `LICENSE` and at
https://creativecommons.org/licenses/by-sa/4.0/. This adapted version is distributed under the
same license. It is provided as is, without warranties.

Changes made for ai-scanner's `security` Scan Profile:

- `references/` (the six category corpora, `.md` and `.json`): vendored unchanged.
- `SKILL.md`: new. Upstream runs these corpora through a Claude Code Workflow pipeline
  (`commands/audit.md`, `workflows/audit.js`) with parallel sub-agents, which is not vendored. The
  skill restates, for a single read-only agent, the sweep and the refuting verification described
  in the upstream `README.md` (seed and derived patterns, configurable vs unconditional
  candidates, the five verification steps).
