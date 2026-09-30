# The server fills a standard Report template; the agent writes only data

A Scan Profile can bring a Report Template (`profiles/<name>/report/`). The agent then writes only `findings.json`: the Findings plus a `report` object holding the Report's narrative (summary, scope, dependencies, strengths, recommendations, dismissed candidates). The server checks it against the template's JSON Schema, a superset of the shared Findings schema. It then fills two templates from one view of that data: `report.md` (Handlebars) and `report.pdf` (Typst, via `@myriaddreamin/typst-ts-node-compiler`).

The server computes what the agent should not decide:
- the document information (Scan id, date, model, the Source Archive's SHA-256 and file count);
- Finding IDs and their order by severity;
- the severity counts and the overall risk;
- the code excerpts, read from the workspace at each Finding's lines rather than copied by the model.

We chose this because a Report must be standard: the same sections, in the same order, with the same fixed English headings in every Scan. A model filling a free Markdown skeleton drifts, the more so a small local one. Filling a template is deterministic and judges nothing, so ADR-0001 still holds: the server checks structure, not quality. This decision narrows that ADR's contract: with a template, `report.md` is the server's to write, not the agent's.

## Consequences

- The agent's text comes from a model that read untrusted code, so it is treated as data.
  - In Typst it is passed as `sys.inputs` JSON and shown as text, never evaluated as markup.
  - In Markdown the helpers escape it. Headings and table cells get no raw HTML and no column breaks. Text blocks cannot start a heading, a rule or HTML at the beginning of a line, and cannot leave a code fence open.
  - Excerpts are only read inside the workspace.
- The template names only its own fonts (Inter, JetBrains Mono, OFL) and the fonts built into Typst, with fallback off.
  - The same Scan renders to the same bytes on the same server image.
  - The compiler still discovers system fonts, so a host with its own copy of one of these families could render differently.
  - Every character these fonts cover renders, not only Latin-1.
- The Report's fixed text is in English; the agent's text is in the Scan's language.
- Profiles without a template keep the ADR-0001 contract: the agent writes `report.md`, and the server renders the PDF from it with pdfkit.
- The agent cannot run scripts, so a skill cannot validate or render its own output; that work belongs to the server.

## Considered Options

- **Having the model fill a Markdown skeleton**, with the server checking its headings, was rejected: a missed heading burns an Attempt, and the model gets no feedback on why.
- **HTML and headless Chromium for the PDF** was rejected: it adds a browser to the server image, and the output is harder to make byte-stable.
- **Pandoc and LaTeX** were rejected for the same weight, and because they are not an npm dependency.
