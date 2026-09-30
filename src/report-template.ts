import Ajv, { ValidateFunction } from 'ajv';
import Handlebars from 'handlebars';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { FINDING_SEVERITIES } from './output-validator';

/**
 * A Scan Profile's Report template (ADR-0005): the agent writes only `findings.json`, holding the
 * Findings and a `report` object; the server checks it against the profile's schema and fills
 * `report.md` (Handlebars) and `report.pdf` (Typst) from the same view of it. Loaded from
 * `profiles/<name>/report/{schema.json,report.md.hbs,report.typ,fonts/}`.
 */
export interface ReportTemplate {
  /** The profile's schema for `findings.json`, given to the agent in the prompt. */
  schema: object;
  validate: ValidateFunction;
  markdown: HandlebarsTemplateDelegate;
  typstMain: string;
  fontsDir: string;
}

export function loadReportTemplate(dir: string): ReportTemplate | undefined {
  if (!existsSync(join(dir, 'schema.json'))) return undefined;
  const schema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8'));
  return {
    schema,
    validate: new Ajv({ allErrors: true }).compile(schema),
    markdown: markdownEngine().compile(readFileSync(join(dir, 'report.md.hbs'), 'utf8'), { noEscape: true, strict: false }),
    typstMain: join(dir, 'report.typ'),
    fontsDir: join(dir, 'fonts'),
  };
}

type Severity = (typeof FINDING_SEVERITIES)[number];

/** What the server knows about the Scan, next to what the agent wrote. */
export interface ReportContext {
  scanId: string;
  profile: string;
  model: string;
  language: string;
  /** ISO-8601; the Report is dated by it. */
  startedAt: string;
  instructions: string | null;
  attempts: number;
  archiveSha256: string;
  /** Files in the extracted Source Archive. */
  files: number;
  /** The extracted Source Archive, where code excerpts are read from. */
  workspaceDir: string;
}

export interface ExcerptLine {
  n: number;
  text: string;
  /** Within the Finding's `line`..`endLine`. */
  hit: boolean;
}

export interface FindingView {
  id: string;
  severity: Severity;
  severityLabel: string;
  title: string;
  description: string;
  location: string;
  file: string;
  line: number | null;
  otherLocations: string[];
  category: string | null;
  cwe: string | null;
  cweUrl: string | null;
  owasp: string | null;
  confidence: string | null;
  attackScenario: string | null;
  impact: string | null;
  recommendation: string | null;
  references: string[];
  excerpt: { language: string; lines: ExcerptLine[] } | null;
}

export interface ReportView {
  scan: Omit<ReportContext, 'workspaceDir'> & { date: string };
  risk: { level: Severity | 'minimal'; label: string };
  counts: { severity: Severity; label: string; count: number }[];
  total: number;
  summary: string;
  scope: {
    description: string | null;
    languages: string[];
    frameworks: string[];
    entryPoints: string[];
    excluded: { path: string; reason: string }[];
  };
  dependencies: { manifests: string[]; notes: string | null };
  strengths: string[];
  recommendations: string[];
  dismissed: { title: string; location: string | null; reason: string }[];
  findings: FindingView[];
}

const LABELS: Record<Severity | 'minimal', string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
  minimal: 'Minimal',
};

/** Lines of context shown around a Finding, and the most an excerpt shows. */
const CONTEXT_LINES = 2;
const MAX_EXCERPT_LINES = 24;
const MAX_LINE_LENGTH = 160;
const MAX_EXCERPT_FILE_BYTES = 2 * 1024 * 1024;

const LANGUAGES: Record<string, string> = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx',
  '.py': 'python', '.rb': 'ruby', '.php': 'php', '.java': 'java', '.kt': 'kotlin', '.go': 'go', '.rs': 'rust',
  '.cs': 'csharp', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.swift': 'swift', '.scala': 'scala',
  '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell', '.sql': 'sql', '.html': 'html', '.xml': 'xml',
  '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.tf': 'hcl', '.dockerfile': 'dockerfile',
};

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter((s): s is string => s !== null) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);

/** A path as the agent wrote it, relative to the workspace root. */
function workspacePath(file: string): string {
  return file.trim().replace(/\\/g, '/').replace(/^\/workspace\//, '').replace(/^(\.\/)+/, '');
}

function place(file: string, line: number | null): string {
  return line ? `${file}:${line}` : file;
}

/**
 * The code around a Finding, read by the server from the workspace rather than copied by the
 * agent. Nothing outside the workspace is read, and a file that is missing, huge or binary gives
 * no excerpt.
 */
async function excerpt(workspaceDir: string, file: string, line: number | null, endLine: number | null): Promise<FindingView['excerpt']> {
  if (!line) return null;
  const root = resolve(workspaceDir);
  const path = resolve(root, file);
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_EXCERPT_FILE_BYTES) return null;
    const content = await readFile(path, 'utf8');
    if (content.includes('\0')) return null;
    const all = content.split(/\r?\n/);
    if (line > all.length) return null;
    const last = Math.min(Math.max(endLine ?? line, line), line + MAX_EXCERPT_LINES - 1);
    const from = Math.max(1, line - CONTEXT_LINES);
    const to = Math.min(all.length, last + CONTEXT_LINES, from + MAX_EXCERPT_LINES - 1);
    const lines: ExcerptLine[] = [];
    for (let n = from; n <= to; n++) {
      let t = all[n - 1].replace(/\t/g, '  ').trimEnd();
      if (t.length > MAX_LINE_LENGTH) t = t.slice(0, MAX_LINE_LENGTH - 1) + '…';
      lines.push({ n, text: t, hit: n >= line && n <= last });
    }
    const name = file.split('/').pop()!.toLowerCase();
    return { language: LANGUAGES[extname(name)] ?? (name === 'dockerfile' ? 'dockerfile' : ''), lines };
  } catch {
    return null;
  }
}

/**
 * The view both templates render: the agent's `findings.json` (already valid against the
 * profile's schema) tidied up, with what only the server knows. Findings are ordered by
 * severity, keeping the agent's order within one, and numbered F-001, F-002...
 */
export async function buildReportView(data: unknown, ctx: ReportContext): Promise<ReportView> {
  const root = obj(data);
  const report = obj(root.report);
  const scope = obj(report.scope);
  const deps = obj(report.dependencies);
  const rank = (s: Severity) => FINDING_SEVERITIES.indexOf(s);
  const raw = (Array.isArray(root.findings) ? root.findings : []).map(obj);
  const sorted = raw
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f.severity as Severity) - rank(b.f.severity as Severity) || a.i - b.i)
    .map(({ f }) => f);

  const findings: FindingView[] = [];
  for (const [i, f] of sorted.entries()) {
    const severity = f.severity as Severity;
    const loc = obj(f.location);
    const file = workspacePath(String(loc.file));
    const line = int(loc.line);
    const cweNumber = text(f.cwe)?.match(/\d+/)?.[0];
    findings.push({
      id: `F-${String(i + 1).padStart(3, '0')}`,
      severity,
      severityLabel: LABELS[severity],
      // The schema asks for non-blank text; the templates must still never see a missing one.
      title: text(f.title) ?? 'Untitled',
      description: text(f.description) ?? '',
      location: place(file, line),
      file,
      line,
      otherLocations: (Array.isArray(f.otherLocations) ? f.otherLocations : [])
        .map(obj)
        .filter((o) => text(o.file))
        .map((o) => place(workspacePath(String(o.file)), int(o.line))),
      category: text(f.category),
      cwe: cweNumber ? `CWE-${cweNumber}` : text(f.cwe),
      cweUrl: cweNumber ? `https://cwe.mitre.org/data/definitions/${cweNumber}.html` : null,
      owasp: text(f.owasp),
      confidence: text(f.confidence)?.toLowerCase() ?? null,
      attackScenario: text(f.attackScenario),
      impact: text(f.impact),
      recommendation: text(f.recommendation),
      references: texts(f.references),
      excerpt: await excerpt(ctx.workspaceDir, file, line, int(loc.endLine)),
    });
  }

  const counts = FINDING_SEVERITIES.map((severity) => ({
    severity,
    label: LABELS[severity],
    count: findings.filter((f) => f.severity === severity).length,
  }));
  const worst = counts.find((c) => c.count > 0 && c.severity !== 'info')?.severity ?? 'minimal';
  const { workspaceDir: _, ...scan } = ctx;
  return {
    scan: { ...scan, date: ctx.startedAt.slice(0, 10) },
    risk: { level: worst, label: LABELS[worst] },
    counts,
    total: findings.length,
    summary: text(report.summary) ?? '',
    scope: {
      description: text(scope.description),
      languages: texts(scope.languages),
      frameworks: texts(scope.frameworks),
      entryPoints: texts(scope.entryPoints),
      excluded: (Array.isArray(scope.excluded) ? scope.excluded : [])
        .map(obj)
        .filter((e) => text(e.path))
        .map((e) => ({ path: text(e.path)!, reason: text(e.reason) ?? '' })),
    },
    dependencies: { manifests: texts(deps.manifests), notes: text(deps.notes) },
    strengths: texts(report.strengths),
    recommendations: texts(report.recommendations),
    dismissed: (Array.isArray(report.dismissed) ? report.dismissed : [])
      .map(obj)
      .filter((d) => text(d.title))
      .map((d) => ({ title: text(d.title)!, location: text(d.location), reason: text(d.reason) ?? '' })),
    findings,
  };
}

/**
 * Handlebars with the helpers the Markdown template needs to keep the agent's text from
 * changing the Report's structure: the text comes from a model that read untrusted code.
 */
function markdownEngine(): typeof Handlebars {
  const hb = Handlebars.create();
  /** Text for a table cell or a heading: one line, no column breaks, no raw HTML. */
  hb.registerHelper('cell', (v: unknown) =>
    String(v ?? '')
      .replace(/\s*\r?\n\s*/g, ' ')
      .replace(/([|<])/g, '\\$1'),
  );
  /** Inline code that no backtick in it can close early. */
  hb.registerHelper('code', (v: unknown) => {
    const s = String(v ?? '').replace(/\s*\r?\n\s*/g, ' ');
    const fence = '`'.repeat(Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
    return fence.length > 1 || s.startsWith('`') || s.endsWith('`') ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
  });
  /**
   * A block of the agent's Markdown that cannot open a heading, a rule or raw HTML, nor leave a
   * code fence open for the rest of the Report.
   */
  hb.registerHelper('block', (v: unknown) => {
    let fence: string | null = null;
    const lines = String(v ?? '')
      .split(/\r?\n/)
      .map((l) => {
        const marker = l.match(/^\s*(`{3,}|~{3,})/)?.[1];
        if (fence) {
          if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
          return l;
        }
        if (marker) {
          fence = marker;
          return l;
        }
        return l.replace(/^(\s*)(#|<|={3,}|-{3,}\s*$|\*{3,}\s*$)/, '$1\\$2');
      });
    if (fence) lines.push(fence);
    return lines.join('\n');
  });
  /** A fenced code block around lines, the fence longer than any in them. */
  hb.registerHelper('fence', (lines: ExcerptLine[], language: string) => {
    const body = lines.map((l) => `${l.hit ? '>' : ' '} ${String(l.n).padStart(4)}  ${l.text}`).join('\n');
    const fence = '`'.repeat(Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
    return `${fence}${language}\n${body}\n${fence}`;
  });
  /** Plain text shown as it is, in a fence longer than any in it. */
  hb.registerHelper('verbatim', (v: unknown) => {
    const body = String(v ?? '').trimEnd();
    const fence = '`'.repeat(Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
    return `${fence}text\n${body}\n${fence}`;
  });
  hb.registerHelper('join',(list: unknown, sep: unknown) => (Array.isArray(list) ? list.join(typeof sep === 'string' ? sep : ', ') : ''));
  hb.registerHelper('inc', (i: unknown) => Number(i) + 1);
  return hb;
}

export function fillMarkdownTemplate(template: ReportTemplate, view: ReportView): string {
  return template.markdown(view).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** One Typst compiler per template: it loads the template's fonts once. */
const compilers = new Map<string, NodeCompiler>();

/**
 * Renders the Typst template with the view as `sys.inputs.data`: the agent's text only ever
 * reaches Typst as data, never as markup. Fonts come from the template's `fonts/` and the
 * fonts built into Typst, which the template names explicitly, so hosts render alike.
 */
export function fillPdfTemplate(template: ReportTemplate, view: ReportView): Buffer {
  let compiler = compilers.get(template.typstMain);
  if (!compiler) {
    compiler = NodeCompiler.create({ workspace: resolve(template.typstMain, '..'), fontArgs: [{ fontPaths: [template.fontsDir] }] });
    compilers.set(template.typstMain, compiler);
  }
  const result = compiler.compile({ mainFilePath: template.typstMain, inputs: { data: JSON.stringify(view) } });
  if (!result.result) {
    const error = result.takeError() ?? result.takeDiagnostics();
    const diagnostics: { message: string }[] = error ? compiler.fetchDiagnostics(error) : [];
    throw new Error(`Typst: ${diagnostics.map((d) => d.message).join('; ') || 'compilation failed'}`);
  }
  const pdf = compiler.pdf(result.result);
  // Every Scan brings new inputs: keep Typst's memoisation from growing for the server's lifetime.
  compiler.evictCache(10);
  return pdf;
}
