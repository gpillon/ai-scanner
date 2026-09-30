/**
 * What a caller may see of an Attempt while it runs: one short line per thing the agent does,
 * summarised from the transcript. Never the transcript itself: it holds the prompt, the Scan
 * Profile's skills (server-owned, ADR-0004) and whole files the agent read.
 */
export interface Activity {
  attempt: number;
  /** ISO time the agent did it, or the time the server read it when the agent gave none. */
  at: string;
  kind: 'tool' | 'text' | 'step' | 'error' | 'log';
  /** For `tool`: read, grep, glob, list, skill, write, todowrite... */
  tool?: string;
  /** For `tool`: false when the tool call failed. */
  ok?: boolean;
  text: string;
}

const MAX_TEXT = 2000;
const MAX_ARG = 200;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A path as the caller knows it: relative to their code, to the output, or to the skills. */
function shortPath(p: unknown): string {
  if (typeof p !== 'string') return '';
  for (const [root, shown] of [
    ['/workspace', ''],
    ['/output', 'output/'],
    ['/skills', 'skills/'],
  ] as const) {
    if (p === root) return shown || '.';
    if (p.startsWith(`${root}/`)) return shown + p.slice(root.length + 1);
  }
  return p;
}

function toolLine(tool: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? clip(v, MAX_ARG) : '');
  switch (tool) {
    case 'read':
    case 'write':
    case 'edit':
      return shortPath(input.filePath);
    case 'list':
      return shortPath(input.path);
    case 'grep':
    case 'glob': {
      const where = input.path ? ` in ${shortPath(input.path)}` : '';
      const include = input.include ? ` (${str(input.include)})` : '';
      return `${str(input.pattern)}${include}${where}`;
    }
    case 'skill':
      return str(input.name);
    case 'todowrite':
      return Array.isArray(input.todos) ? `${input.todos.length} to-dos` : '';
    default:
      return '';
  }
}

/**
 * The Activity one transcript line stands for, if any. opencode writes one JSON event per line
 * (`--format json`); anything else on the line is its log output.
 */
export function summarise(line: string, attempt: number, now: () => Date): Activity | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let event: { type?: string; timestamp?: number; part?: Record<string, any>; error?: unknown };
  try {
    event = JSON.parse(trimmed);
  } catch {
    return { attempt, at: now().toISOString(), kind: 'log', text: clip(trimmed, MAX_TEXT) };
  }
  const at = new Date(typeof event.timestamp === 'number' ? event.timestamp : now().getTime()).toISOString();
  const part = event.part ?? {};
  switch (event.type) {
    case 'tool_use': {
      const tool = String(part.tool ?? 'tool');
      const state = part.state ?? {};
      const ok = state.status !== 'error';
      const detail = toolLine(tool, state.input ?? {});
      const error = ok ? '' : ` — ${clip(String(state.error ?? 'failed'), MAX_ARG)}`;
      return { attempt, at, kind: 'tool', tool, ok, text: `${detail}${error}` };
    }
    case 'text': {
      const text = typeof part.text === 'string' ? part.text.trim() : '';
      return text ? { attempt, at, kind: 'text', text: clip(text, MAX_TEXT) } : undefined;
    }
    case 'step_finish': {
      const tokens = part.tokens?.total;
      return typeof tokens === 'number' ? { attempt, at, kind: 'step', text: `${tokens} tokens` } : undefined;
    }
    case 'error': {
      const e = event.error as { name?: string; data?: { message?: string } } | undefined;
      const message = e?.data?.message ?? e?.name ?? 'error';
      return { attempt, at, kind: 'error', text: clip(String(message), MAX_TEXT) };
    }
    default:
      return undefined;
  }
}
