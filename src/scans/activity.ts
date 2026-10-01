import { parseUsageLine } from '../runner/usage';

/**
 * What a caller may see of an Attempt while it runs: one short line per thing the agent does,
 * summarised from the transcript. Never the transcript itself: it holds the prompt, the Scan
 * Profile's skills (server-owned, ADR-0004) and whole files the agent read.
 */
export interface Activity {
  attempt: number;
  /** ISO time the agent did it, or the time the server read it when the agent gave none. */
  at: string;
  kind: 'tool' | 'text' | 'step' | 'error' | 'log' | 'subagent';
  /** The subagent that did it (its task's description), or absent for the main agent. */
  subagent?: string;
  /** For `subagent`: how many subagents are active, after this event. */
  active?: number;
  /** For `tool`: read, grep, glob, list, skill, write, todowrite... */
  tool?: string;
  /** For `tool`: false when the tool call failed; for a finished `subagent`: false when it failed. */
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
    case 'task':
      return str(input.description);
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
  let event: AgentEvent;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return { attempt, at: now().toISOString(), kind: 'log', text: clip(trimmed, MAX_TEXT) };
  }
  const activity = describe(event, trimmed, attempt, now);
  // containers/agent/run.js adds the events of subagent sessions, titled "<description> (@<agent> subagent)".
  if (activity && typeof event.subagent === 'string') {
    activity.subagent = clip(event.subagent.replace(/\s*\(@[^)]*\)\s*$/, ''), MAX_ARG);
  }
  return activity;
}

/** One JSON line of the transcript: an opencode event, or the agent container's usage line. */
interface AgentEvent {
  type?: string;
  timestamp?: number;
  part?: Record<string, any>;
  error?: unknown;
  /** Set on a subagent session's event, by containers/agent/run.js: the session's title. */
  subagent?: unknown;
  /** Set on a subagent started/finished line, by containers/agent/run.js. */
  state?: string;
  active?: number;
  ok?: boolean;
}

function describe(event: AgentEvent, line: string, attempt: number, now: () => Date): Activity | undefined {
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
    case 'usage': {
      // The agent container's last line (containers/agent/usage.js): the Attempt's whole usage.
      const u = parseUsageLine(line);
      if (!u) return undefined;
      const n = (v: number) => v.toLocaleString('en-US');
      const sessions = u.sessions > 1 ? `, ${u.sessions} sessions (${u.sessions - 1} subagent${u.sessions > 2 ? 's' : ''})` : '';
      return {
        attempt,
        at: now().toISOString(),
        kind: 'step',
        text: `Attempt total: ${n(u.total)} tokens (input ${n(u.input)}, output ${n(u.output)}, cache read ${n(u.cacheRead)})${sessions}`,
      };
    }
    case 'error': {
      const e = event.error as { name?: string; data?: { message?: string } } | undefined;
      const message = e?.data?.message ?? e?.name ?? 'error';
      return { attempt, at, kind: 'error', text: clip(String(message), MAX_TEXT) };
    }
    case 'subagent': {
      // containers/agent/run.js's started/finished line for a `task` call: the subagent's name,
      // never its prompt or output. `active` is how many are still running, after this event.
      const name = typeof event.subagent === 'string' ? event.subagent : '';
      const active = typeof event.active === 'number' ? event.active : 0;
      if (event.state === 'started') {
        return { attempt, at, kind: 'subagent', subagent: name, active, text: `started (${active} active)` };
      }
      if (event.state === 'finished') {
        const ok = event.ok === true;
        return { attempt, at, kind: 'subagent', subagent: name, active, ok, text: `${ok ? 'finished' : 'failed'} (${active} active)` };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
