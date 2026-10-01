'use strict';
// Prints, as one last JSON line on stdout, the tokens opencode used in this Attempt: the main
// session and every subagent session it started. The JSON event stream carries the main
// session's tokens only; opencode's own database has every session's totals. HOME is fresh for
// each Attempt, so every session in it belongs to this one. Prints nothing when it cannot tell.

const { join } = require('node:path');

try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(join(process.env.HOME || '/tmp', '.local', 'share', 'opencode', 'opencode.db'), { readOnly: true });
  const rows = db
    .prepare(
      `SELECT id, parent_id AS parent, agent, title, cost,
              tokens_input AS input, tokens_output AS output, tokens_reasoning AS reasoning,
              tokens_cache_read AS cacheRead, tokens_cache_write AS cacheWrite
       FROM session ORDER BY time_created`,
    )
    .all();
  const sum = (key) => rows.reduce((total, r) => total + (Number(r[key]) || 0), 0);
  const tokens = {
    input: sum('input'),
    output: sum('output'),
    reasoning: sum('reasoning'),
    cacheRead: sum('cacheRead'),
    cacheWrite: sum('cacheWrite'),
  };
  tokens.total = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
  const usage = {
    type: 'usage',
    tokens,
    cost: sum('cost'),
    sessions: rows.map((r) => ({
      agent: r.agent,
      title: r.title,
      subagent: Boolean(r.parent),
      tokens: { input: r.input, output: r.output, reasoning: r.reasoning, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite },
      cost: r.cost,
    })),
  };
  process.stdout.write(`${JSON.stringify(usage)}\n`);
} catch {
  // No database (opencode never started) or a schema this script does not know: no usage line.
}
