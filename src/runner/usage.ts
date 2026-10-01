import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Tokens an Attempt or a Scan used, every session of the agent included (subagents too). */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** As the provider reports it; 0 when it reports none (e.g. a local model). */
  cost: number;
  /** Agent sessions: the main one plus one per subagent it started. */
  sessions: number;
}

const FIELDS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total', 'cost', 'sessions'] as const;

export const NO_USAGE: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, sessions: 0 };

/**
 * The usage line of a transcript line, `{"type":"usage", ...}`, which the agent container
 * prints after opencode (containers/agent/usage.js); undefined for any other line.
 */
export function parseUsageLine(line: string): TokenUsage | undefined {
  if (!line.startsWith('{"type":"usage"')) return undefined;
  try {
    const u = JSON.parse(line);
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const tokens = u.tokens ?? {};
    const usage = {
      input: n(tokens.input),
      output: n(tokens.output),
      reasoning: n(tokens.reasoning),
      cacheRead: n(tokens.cacheRead),
      cacheWrite: n(tokens.cacheWrite),
      total: 0,
      cost: n(u.cost),
      sessions: Array.isArray(u.sessions) ? u.sessions.length : 0,
    };
    usage.total = n(tokens.total) || usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
    return usage;
  } catch {
    return undefined;
  }
}

/** The usage an Attempt's transcript reports, or undefined when it has none (an older agent image, a crash). */
export async function attemptUsage(transcriptPath: string): Promise<TokenUsage | undefined> {
  let found: TokenUsage | undefined;
  try {
    const lines = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity });
    for await (const line of lines) found = parseUsageLine(line) ?? found;
  } catch {
    return undefined;
  }
  return found;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return Object.fromEntries(FIELDS.map((k) => [k, a[k] + b[k]])) as unknown as TokenUsage;
}
