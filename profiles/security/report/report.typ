// The standard security Report as a PDF, the same sections as report.md.hbs, filled by the
// server with the view of findings.json passed as `sys.inputs.data` (src/reports/report-template.ts).
// The agent's text only ever arrives as data: it is shown as text, never evaluated as markup.
// Fonts: Inter and JetBrains Mono from fonts/, then the fonts built into Typst; `fallback: false`
// keeps system fonts out, so every host renders alike.

#let d = json(bytes(sys.inputs.data))
#let scan = d.scan

// ---------------------------------------------------------------- palette and type
#let ink = rgb("#0f172a")
#let body-ink = rgb("#1e293b")
#let muted = rgb("#64748b")
#let rule = rgb("#e2e8f0")
#let soft = rgb("#f8fafc")
#let code-bg = rgb("#f1f5f9")
#let navy = rgb("#0b1f44")
#let accent = rgb("#2563eb")
#let sev-color = (
  critical: rgb("#b91c1c"),
  high: rgb("#ea580c"),
  medium: rgb("#ca8a04"),
  low: rgb("#2563eb"),
  info: rgb("#64748b"),
  minimal: rgb("#15803d"),
)
#let sans = ("Inter", "Libertinus Serif", "DejaVu Sans Mono")
#let mono = ("JetBrains Mono", "DejaVu Sans Mono")

// ---------------------------------------------------------------- document
#set document(title: "Security Assessment Report - " + scan.scanId, author: "ai-scanner", date: none)
#set text(font: sans, fallback: false, size: 9.5pt, fill: body-ink, hyphenate: false, lang: "en")
#set par(justify: false, leading: 0.62em, spacing: 0.95em)
#show raw: set text(font: mono, size: 0.86em, ligatures: false, features: (calt: 0))
#show link: set text(fill: accent)
#set list(marker: text(fill: muted)[•], indent: 2pt, body-indent: 6pt)
#set enum(indent: 2pt, body-indent: 6pt)
#set table(stroke: none)

#set heading(numbering: (..n) => if n.pos().len() == 1 { str(n.pos().first()) + "." })
#show heading.where(level: 1): it => {
  v(34pt, weak: true) // a clear break from the previous chapter; dropped at the top of a page
  block(below: 12pt, {
    set text(size: 17pt, weight: 700, fill: navy)
    if it.numbering != none {
      text(fill: accent)[#counter(heading).display(it.numbering)]
      h(8pt)
    }
    it.body
    v(-6pt)
    line(length: 100%, stroke: 1.2pt + navy)
  })
}
#show heading.where(level: 2): it => block(above: 20pt, below: 8pt, text(size: 11.5pt, weight: 600, fill: ink, it.body))
#show heading.where(level: 3): it => block(above: 12pt, below: 6pt, text(size: 8pt, weight: 700, fill: muted, tracking: 0.6pt, upper(it.body)))

#set page(
  paper: "a4",
  margin: (x: 20mm, top: 24mm, bottom: 22mm),
  header: context {
    if counter(page).get().first() > 1 {
      set text(size: 7.5pt, fill: muted)
      grid(columns: (1fr, auto), [Security Assessment Report], [Scan #raw(scan.scanId)])
      v(-5pt)
      line(length: 100%, stroke: 0.5pt + rule)
    }
  },
  footer: context {
    if counter(page).get().first() > 1 {
      set text(size: 7.5pt, fill: muted)
      grid(
        columns: (1fr, auto),
        [AI-generated security review · Confidential],
        [Page #counter(page).display() of #counter(page).final().first()],
      )
    }
  },
)

// ---------------------------------------------------------------- the agent's text
// A small, safe subset of Markdown: paragraphs, bullet and numbered lists, fenced code,
// inline `code` and **bold**. Everything else shows as it is.

#let md-italic(s) = {
  let parts = s.split("*")
  if calc.even(parts.len()) { return s }
  for (i, p) in parts.enumerate() { if calc.odd(i) and p.trim() == p and p != "" { emph(p) } else if calc.odd(i) { "*" + p + "*" } else { p } }
}

#let md-bold(s) = {
  let parts = s.split("**")
  if calc.even(parts.len()) { return md-italic(s) }
  for (i, p) in parts.enumerate() { if calc.odd(i) { strong(p) } else { md-italic(p) } }
}

#let inline-code(s) = box(fill: code-bg, inset: (x: 2.5pt), outset: (y: 2.2pt), radius: 2pt, raw(s))

#let md-inline(s) = {
  let parts = s.split("`")
  if calc.even(parts.len()) { return md-bold(s) }
  for (i, p) in parts.enumerate() { if calc.odd(i) { inline-code(p) } else { md-bold(p) } }
}

#let code-block(body, lang) = block(
  width: 100%, fill: code-bg, radius: 3pt, inset: (x: 8pt, y: 7pt), breakable: true,
  raw(body, block: true, lang: if lang == "" { none } else { lang }),
)

#let rich(s) = {
  if s == none { return }
  let blocks = ()
  let cur = none
  for line in s.replace("\r", "").split("\n") {
    let t = line.trim()
    if cur != none and cur.kind == "code" {
      if t.starts-with("```") { blocks.push(cur); cur = none } else { cur.lines.push(line) }
      continue
    }
    if t.starts-with("```") {
      if cur != none { blocks.push(cur) }
      cur = (kind: "code", lines: (), lang: t.trim("`").trim())
    } else if t == "" {
      if cur != none { blocks.push(cur); cur = none }
    } else if t.starts-with("- ") or t.starts-with("* ") or t.match(regex("^\d+[.)]\s")) != none {
      let kind = if t.starts-with("- ") or t.starts-with("* ") { "ul" } else { "ol" }
      let item = t.replace(regex("^(?:[-*]|\d+[.)])\s+"), "")
      if cur != none and cur.kind == kind { cur.lines.push(item) } else {
        if cur != none { blocks.push(cur) }
        cur = (kind: kind, lines: (item,))
      }
    } else if cur != none and (cur.kind == "ul" or cur.kind == "ol") and line.starts-with(" ") {
      let last = cur.lines.len() - 1
      cur.lines.at(last) = cur.lines.at(last) + " " + t
    } else {
      let t = t.replace(regex("^#+\s*"), "")
      if cur != none and cur.kind == "p" { cur.lines.push(t) } else {
        if cur != none { blocks.push(cur) }
        cur = (kind: "p", lines: (t,))
      }
    }
  }
  if cur != none { blocks.push(cur) }
  for b in blocks {
    if b.kind == "p" { par(md-inline(b.lines.join(" "))) }
    else if b.kind == "ul" { list(..b.lines.map(md-inline)) }
    else if b.kind == "ol" { enum(..b.lines.map(md-inline)) }
    else { code-block(b.lines.join("\n"), b.lang) }
  }
}

#let not-provided = text(fill: muted, style: "italic")[Not provided.]
#let or-missing(v, f: rich) = if v == none or v == "" or v == () { not-provided } else { f(v) }

// ---------------------------------------------------------------- building blocks
#let pill(label, color) = box(
  fill: color, inset: (x: 5pt, y: 2.6pt), radius: 3pt, baseline: 1.8pt,
  text(fill: white, weight: 700, size: 7pt, tracking: 0.4pt, upper(label)),
)

#let kv(pairs, key-width: 32mm) = grid(
  columns: (key-width, 1fr), column-gutter: 10pt, row-gutter: 7pt,
  ..pairs.map(((k, v)) => (text(fill: muted, size: 7.5pt, weight: 600, tracking: 0.3pt, upper(k)), v)).flatten(),
)

#let data-table(columns, header, rows, align: left) = table(
  columns: columns, inset: (x: 6pt, y: 5.5pt), align: align,
  fill: (_, y) => if y == 0 { navy } else if calc.even(y) { soft } else { none },
  table.header(..header.map(h => text(fill: white, weight: 600, size: 7.5pt, tracking: 0.3pt, upper(h)))),
  ..rows.flatten(),
  table.hline(stroke: 0.6pt + rule),
)

#let label-caps(s) = text(size: 7.5pt, weight: 700, fill: muted, tracking: 0.6pt, upper(s))

#let callout(body, color: accent) = block(
  width: 100%, fill: color.lighten(92%), stroke: (left: 2.5pt + color), inset: (x: 10pt, y: 8pt), radius: (right: 3pt),
  body,
)

// A horizontal bar with one segment per severity, as wide as its share of the Findings.
#let severity-bar() = {
  let present = d.counts.filter(c => c.count > 0)
  if d.total == 0 {
    block(width: 100%, height: 10pt, radius: 5pt, fill: sev-color.minimal.lighten(70%))
  } else {
    box(width: 100%, height: 10pt, radius: 5pt, clip: true, grid(
      columns: present.map(c => c.count * 1fr),
      ..present.map(c => rect(width: 100%, height: 10pt, fill: sev-color.at(c.severity), stroke: none)),
    ))
  }
}

#let severity-tiles(size: 22pt) = grid(
  columns: (1fr,) * 5, column-gutter: 6pt,
  ..d.counts.map(c => block(
    width: 100%, inset: (x: 8pt, y: 8pt), radius: 4pt,
    fill: if c.count > 0 { sev-color.at(c.severity).lighten(90%) } else { soft },
    stroke: (top: 2.5pt + if c.count > 0 { sev-color.at(c.severity) } else { rule }),
    {
      text(size: size, weight: 700, fill: if c.count > 0 { sev-color.at(c.severity) } else { muted.lighten(40%) }, str(c.count))
      linebreak()
      text(size: 7pt, weight: 600, fill: muted, tracking: 0.4pt, upper(c.label))
    },
  )),
)

// The code around a Finding, with line numbers; the lines it points at are tinted.
#let excerpt-block(ex, color) = block(
  width: 100%, radius: 3pt, clip: true, stroke: 0.5pt + rule, breakable: false,
  table(
    columns: (auto, 1fr), inset: (x: 7pt, y: 2.2pt), align: (right, left),
    fill: (x, y) => if ex.lines.at(y).hit { if x == 0 { color.lighten(70%) } else { color.lighten(88%) } } else { code-bg },
    ..ex.lines.map(l => (
      text(font: mono, size: 7.5pt, fill: if l.hit { color.darken(10%) } else { muted }, str(l.n)),
      raw(l.text, lang: if ex.language == "" { none } else { ex.language }),
    )).flatten(),
  ),
)

// ================================================================= cover
#page(
  margin: (x: 0mm, top: 0mm, bottom: 30mm),
  footer: pad(x: 20mm, {
    set text(size: 7.5pt, fill: muted)
    line(length: 100%, stroke: 0.5pt + rule)
    v(2pt)
    [This Report was produced by an AI agent reading the source code. It can contain false positives
    and miss vulnerabilities: review each Finding before acting on it, and do not read the absence
    of a Finding as proof of security.]
  }),
{
  block(width: 100%, inset: (x: 20mm, top: 22mm, bottom: 18mm), fill: navy, spacing: 0pt, {
    set text(fill: white)
    text(size: 8pt, weight: 700, tracking: 2pt, fill: white.darken(25%))[AI-SCANNER · #upper(scan.profile) PROFILE]
    v(10pt)
    text(size: 30pt, weight: 800, tracking: -0.4pt)[Security Assessment Report]
    v(4pt)
    text(size: 11pt, fill: white.darken(20%))[Static source code review · #scan.date]
  })
  block(width: 100%, height: 4pt, fill: sev-color.at(d.risk.level), spacing: 0pt)
  v(16mm)
  pad(x: 20mm, {

  grid(
    columns: (52mm, 1fr), column-gutter: 10mm,
    block(width: 100%, inset: 12pt, radius: 6pt, fill: sev-color.at(d.risk.level).lighten(90%), stroke: 1pt + sev-color.at(d.risk.level), {
      label-caps("Overall risk")
      v(2pt)
      text(size: 26pt, weight: 800, fill: sev-color.at(d.risk.level), d.risk.label)
      v(0pt)
      text(size: 8pt, fill: muted)[#d.total Finding#if d.total != 1 [s] after triage]
    }),
    {
      label-caps("Findings by severity")
      v(4pt)
      severity-tiles(size: 18pt)
      v(8pt)
      severity-bar()
    },
  )
  v(14mm)

  label-caps("Scan")
  v(2pt)
  line(length: 100%, stroke: 0.5pt + rule)
  v(4pt)
  kv((
    ("Scan ID", raw(scan.scanId)),
    ("Date", scan.date),
    ("Scan Profile", scan.profile),
    ("Model", raw(scan.model)),
    ("Report language", scan.language),
    ("Source", [#scan.files files · #scan.sourceLabel #linebreak() #text(size: 7.5pt, raw(scan.sourceValue))]),
    ("Attempts", str(scan.attempts)),
  ))

  })
})

// ================================================================= contents
#counter(page).update(2)
#{
  show outline.entry.where(level: 1): it => { v(5pt); strong(it) }
  outline(title: text(size: 17pt, weight: 700, fill: navy)[Contents], depth: 2, indent: 1.2em)
}

// ================================================================= 1. executive summary
#pagebreak(weak: true)
= Executive Summary

#grid(
  columns: (1fr, 46mm), column-gutter: 8mm,
  {
    rich(d.summary)
  },
  block(width: 100%, inset: 10pt, radius: 4pt, fill: sev-color.at(d.risk.level).lighten(90%), stroke: (left: 3pt + sev-color.at(d.risk.level)), {
    label-caps("Overall risk")
    v(0pt)
    text(size: 18pt, weight: 800, fill: sev-color.at(d.risk.level), d.risk.label)
    v(0pt)
    text(size: 8pt, fill: muted)[#d.total Finding#if d.total != 1 [s]]
  }),
)

== Findings by Severity
#severity-tiles()
#v(6pt)
#severity-bar()

#if d.total > 0 [
  == Most Severe Findings
  #data-table(
    (auto, auto, 1fr),
    ("ID", "Severity", "Title"),
    d.findings.slice(0, calc.min(5, d.total)).map(f => (
      text(weight: 600, f.id), pill(f.severityLabel, sev-color.at(f.severity)), md-inline(f.title),
    )),
  )
]

// ================================================================= 2. scope
= Scope

== Target
#or-missing(d.scope.description)

#kv((
  ("Languages", or-missing(d.scope.languages, f: v => v.join(", "))),
  ("Frameworks", or-missing(d.scope.frameworks, f: v => v.join(", "))),
))

== Entry Points
#or-missing(d.scope.entryPoints, f: v => list(..v.map(md-inline)))

== Exclusions
#if d.scope.excluded.len() == 0 [None: the whole Source Archive was in scope.] else {
  data-table((auto, 1fr), ("Path", "Reason"), d.scope.excluded.map(e => (raw(e.path), md-inline(e.reason))))
}

== Caller Instructions
#if scan.instructions == none [None.] else { code-block(scan.instructions, "") }

// ================================================================= 3. methodology
= Methodology

The review was static and offline: an AI agent read and searched the code, without running it,
installing anything or reaching the network. It followed a fixed workflow:

+ *Map the codebase*: languages, frameworks, entry points, sources of configuration and secrets.
+ *Audit the dependencies* against a local watchlist of known-vulnerable versions.
+ *Sweep for secrets and insecure defaults*: fallback secrets, default credentials, fail-open
  switches, weak cryptography, permissive access, debug leakage.
+ *Deep scan* for injection, broken authentication and access control, unsafe data handling,
  cryptographic misuse and business-logic flaws, and review of misuse-prone APIs.
+ *Trace data flow across files*, from each entry point to its sinks.
+ *Triage every candidate* against known false-positive patterns and seven exploitability tests;
  only candidates with high or medium confidence are kept.

Severities follow the scale in Appendix A. Code excerpts are taken by the server from the Source
Archive at the reported lines; the tinted lines are the ones the Finding points at.

// ================================================================= 4. overview
= Findings Overview

#if d.total == 0 {
  callout(color: sev-color.minimal)[No Finding survived triage.]
} else {
  data-table(
    (auto, auto, 1fr, auto, auto),
    ("ID", "Severity", "Title", "Location", "CWE"),
    d.findings.map(f => (
      text(weight: 600, f.id),
      pill(f.severityLabel, sev-color.at(f.severity)),
      md-inline(f.title),
      text(size: 8pt, raw(f.location)),
      if f.cwe == none { text(fill: muted)[-] } else { text(size: 8pt, f.cwe) },
    )),
  )
}

// ================================================================= 5. details
#if d.total > 0 { pagebreak(weak: true) }
= Detailed Findings

#if d.total == 0 {
  callout(color: sev-color.minimal)[No Finding survived triage.]
}

#for (i, f) in d.findings.enumerate() {
  let color = sev-color.at(f.severity)
  if i > 0 { v(10pt) }
  block(width: 100%, breakable: true, stroke: (left: 3pt + color), inset: (left: 12pt, y: 2pt), {
    heading(level: 2, numbering: none, outlined: true, bookmarked: true)[#f.id #h(4pt) #f.title]
    v(-4pt)
    pill(f.severityLabel, color)
    if f.confidence != none { h(4pt); box(stroke: 0.6pt + muted, inset: (x: 5pt, y: 2.2pt), radius: 3pt, baseline: 1.8pt, text(size: 7pt, weight: 600, fill: muted, upper(f.confidence + " confidence"))) }
    v(6pt)
    block(width: 100%, fill: soft, inset: 9pt, radius: 3pt, kv(key-width: 26mm, (
      ("Location", raw(f.location)),
      ..if f.otherLocations.len() > 0 { (("Also at", f.otherLocations.map(raw).join(", ")),) } else { () },
      ("Category", or-missing(f.category, f: raw)),
      ("CWE", if f.cweUrl != none { link(f.cweUrl, f.cwe) } else { or-missing(f.cwe, f: v => v) }),
      ("OWASP Top 10", or-missing(f.owasp, f: v => v)),
    )))

    heading(level: 3, outlined: false, numbering: none)[Description]
    rich(f.description)

    heading(level: 3, outlined: false, numbering: none)[Evidence]
    if f.excerpt == none {
      text(fill: muted, style: "italic")[No excerpt: the location has no line, or the file could not be read.]
    } else {
      text(size: 7.5pt, fill: muted, raw(f.file))
      v(-4pt)
      excerpt-block(f.excerpt, color)
    }

    heading(level: 3, outlined: false, numbering: none)[Attack Scenario]
    or-missing(f.attackScenario)

    heading(level: 3, outlined: false, numbering: none)[Impact]
    or-missing(f.impact)

    heading(level: 3, outlined: false, numbering: none)[Recommendation]
    if f.recommendation == none { not-provided } else { callout(color: sev-color.minimal, rich(f.recommendation)) }

    heading(level: 3, outlined: false, numbering: none)[References]
    let refs = if f.cweUrl != none { ((f.cwe + ": ", f.cweUrl),) } else { () }
    refs += f.references.map(r => ("", r))
    if refs.len() == 0 [None.] else {
      set text(size: 8.5pt)
      list(..refs.map(((pre, url)) => [#pre#if url.starts-with("http") { link(url) } else { url }]))
    }
  })
}

// ================================================================= 6. dependencies
#pagebreak(weak: true)
= Dependency Review

#kv((("Manifests read", or-missing(d.dependencies.manifests, f: v => v.map(raw).join(", "))),))
#v(4pt)
#or-missing(d.dependencies.notes)

#callout[The dependency check compares versions against a short local watchlist and cannot consult a
vulnerability database: run a software composition analysis tool for complete coverage.]

// ================================================================= 7. strengths
= Security Strengths

#or-missing(d.strengths, f: v => list(..v.map(md-inline)))

// ================================================================= 8. recommendations
= Strategic Recommendations

#or-missing(d.recommendations, f: v => enum(..v.map(md-inline)))

// ================================================================= 9. triage
= Triage: Dismissed Candidates

#if d.dismissed.len() == 0 [None reported.] else {
  data-table(
    (1fr, auto, 1.4fr),
    ("Candidate", "Location", "Reason for dismissal"),
    d.dismissed.map(c => (
      md-inline(c.title),
      if c.location == none { text(fill: muted)[-] } else { text(size: 8pt, raw(c.location)) },
      md-inline(c.reason),
    )),
  )
}

// ================================================================= 10. limitations
= Limitations

- *Static review only.* Nothing was executed: runtime configuration, deployed infrastructure and
  behaviour that depends on data were not observed.
- *Offline.* No vulnerability database or advisory was consulted; known CVEs are reported only
  when the agent was certain of them.
- *AI-generated.* Findings can be wrong or incomplete; confidence reflects the agent's own
  judgement after triage.
- *Scope.* Only the Source Archive identified by its SHA-256 on the cover was reviewed, minus
  any exclusions in section 2.

// ================================================================= appendix
#pagebreak(weak: true)
#heading(level: 1, numbering: none)[Appendix A. Severity Scale]

#data-table(
  (auto, 1.2fr, 1.4fr),
  ("Severity", "Meaning", "Examples"),
  (
    (pill("Critical", sev-color.critical), [Exploitable remotely without special conditions; severe impact], [SQL injection, RCE, authentication bypass, live cloud credentials committed]),
    (pill("High", sev-color.high), [Clear exploit path with serious impact], [Stored XSS, IDOR on sensitive data, hardcoded signing secret]),
    (pill("Medium", sev-color.medium), [Exploitable under specific conditions, or by chaining], [CSRF, weak password hashing]),
    (pill("Low", sev-color.low), [Real but low direct risk], [Verbose errors, missing security headers, outdated dependency with no known exploit]),
    (pill("Info", sev-color.info), [Hardening advice, no direct risk], [Defence-in-depth suggestions]),
  ),
)

The overall risk is the highest severity among the Findings, ignoring Info; with none it is
#text(weight: 600, fill: sev-color.minimal)[Minimal].
