'use strict';
// The agent container's command: runs `opencode <args>` and prints its JSON event stream, adding
// the events of every subagent session, then the Attempt's usage line (usage.js). opencode's
// stream holds the main session only: a subagent started by the `task` tool shows nothing until
// it returns. Its parts are in opencode's database, which this script polls while opencode runs.
//
// It is the only writer of stdout, line by line: a second process writing to the container's
// output could split opencode's lines, since the Runners read stdout and stderr as one stream.
// Exits with opencode's exit code. It also stops opencode when a session stalls: the model keeps
// answering with nothing, which opencode retries forever.

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { join } = require('node:path');
const { constants } = require('node:os');
const { printUsage } = require('./usage.js');

const DB = join(process.env.HOME || '/tmp', '.local', 'share', 'opencode', 'opencode.db');
const POLL_MS = 2000;
/** Steps in a row a session may end with no output and no reason before the Attempt is stopped. */
const STALL_STEPS = 20;

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

// stdin is /dev/null, so nothing joins the prompt.
const child = spawn('opencode', process.argv.slice(2), { stdio: ['ignore', 'pipe', 'inherit'] });
createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  process.stdout.write(`${line}\n`);
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event?.part && event.sessionID) watch(event.sessionID, undefined, event.part);
});

/** Empty steps in a row, by session; whether the Attempt was stopped for one. */
const emptySteps = new Map();
let stalled = false;

/**
 * Counts the steps a session ends with no output and no finish reason, which is what opencode
 * records when the model answers with an error it does not recognise (seen: a local server out
 * of memory at 344k tokens of context, retried 531 times). At STALL_STEPS in a row, it prints
 * an error event and stops opencode: the Attempt ends, and the supervisor starts another.
 */
function watch(session, title, part) {
  if (part.type === 'step-start') return;
  if (part.type !== 'step-finish' || part.reason !== 'unknown' || part.tokens?.output > 0) {
    emptySteps.set(session, 0);
    return;
  }
  const n = (emptySteps.get(session) ?? 0) + 1;
  emptySteps.set(session, n);
  if (n < STALL_STEPS || stalled) return;
  stalled = true;
  out({
    type: 'error',
    timestamp: Date.now(),
    sessionID: session,
    ...(title && { subagent: title }),
    error: { name: 'StalledModel', data: { message: `The model answered ${n} times in a row with nothing: the Attempt is stopped` } },
  });
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
}

// Node is PID 1 in the container: a stop signal must reach opencode, or the stop waits it out.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));

/** Subagent parts already printed, and the newest update seen: only later ones are read. */
const printed = new Set();
let since = 0;
let db;

/** The main session's `task` calls, by part id: whether their started/finished lines are printed. */
const taskState = new Map();

/** How many `task` calls have started but not finished, after the event just printed. */
function activeTasks() {
  let n = 0;
  for (const st of taskState.values()) if (st.started && !st.finished) n++;
  return n;
}

/** A subagent started/finished line: the task's description, never its prompt or output. */
function taskLine(updated, state, description, ok) {
  const line = { type: 'subagent', timestamp: updated, state };
  if (state === 'finished') line.ok = ok;
  line.subagent = description;
  line.active = activeTasks();
  return line;
}

/** The event opencode itself prints for a finished part, or undefined while it is not finished. */
function eventOf(part) {
  switch (part.type) {
    case 'tool':
      return ['completed', 'error'].includes(part.state?.status) ? 'tool_use' : undefined;
    case 'text':
      return part.time?.end ? 'text' : undefined;
    case 'step-finish':
      return 'step_finish';
    default:
      return undefined;
  }
}

/** Prints the subagent parts finished since the last poll. */
function poll() {
  try {
    if (!db) {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(DB, { readOnly: true });
    }
    const rows = db
      .prepare(
        `SELECT p.id, p.session_id AS session, p.time_updated AS updated, p.data, s.title
         FROM part p JOIN session s ON s.id = p.session_id
         WHERE s.parent_id IS NOT NULL AND p.time_updated >= ?
         ORDER BY p.time_updated`,
      )
      .all(since);
    for (const row of rows) {
      since = Math.max(since, row.updated);
      if (printed.has(row.id)) continue;
      const part = JSON.parse(row.data);
      const type = eventOf(part);
      if (!type) continue;
      printed.add(row.id);
      out({ type, timestamp: row.updated, sessionID: row.session, subagent: row.title, part: { id: row.id, ...part } });
      watch(row.session, row.title, part);
    }
    pollTasks();
  } catch {
    // No database yet (opencode is starting), the database busy, or a schema this script does
    // not know: try again at the next poll. The main session's stream is unaffected.
    if (db) {
      try {
        db.close();
      } catch {}
      db = undefined;
    }
  }
}

/**
 * The main session's `task` calls, one per subagent: a started line when a call starts, a
 * finished line when it ends. Read in full each poll, so a call that ran and finished between
 * two polls still gets both lines; `taskState` keeps each line printed once.
 */
function pollTasks() {
  const rows = db
    .prepare(
      `SELECT p.id, p.time_updated AS updated, p.data
       FROM part p JOIN session s ON s.id = p.session_id
       WHERE s.parent_id IS NULL AND json_extract(p.data, '$.tool') = 'task'
       ORDER BY p.time_updated`,
    )
    .all();
  for (const row of rows) {
    let part;
    try {
      part = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (part.type !== 'tool' || part.tool !== 'task') continue;
    const status = part.state?.status;
    if (!['running', 'completed', 'error'].includes(status)) continue;
    const description = typeof part.state?.input?.description === 'string' ? part.state.input.description : '';
    let st = taskState.get(row.id);
    if (!st) {
      st = { description, started: false, finished: false };
      taskState.set(row.id, st);
    }
    if (status === 'running' && !st.started) {
      st.started = true;
      out(taskLine(row.updated, 'started', st.description));
    }
    if ((status === 'completed' || status === 'error') && !st.finished) {
      if (!st.started) {
        st.started = true;
        out(taskLine(row.updated, 'started', st.description));
      }
      st.finished = true;
      out(taskLine(row.updated, 'finished', st.description, status === 'completed'));
    }
  }
}

const timer = setInterval(poll, POLL_MS);

let finished = false;
/** The last subagent parts, then the usage line, whatever opencode's exit code. */
function finish(code) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  poll();
  try {
    db?.close();
  } catch {}
  printUsage();
  // Not process.exit(): it would drop stdout writes still queued for the pipe.
  process.exitCode = stalled && code === 0 ? 1 : code;
}

child.on('error', (e) => {
  process.stderr.write(`could not start opencode: ${e.message}\n`);
  finish(127);
});
child.on('close', (code, signal) => finish(code ?? (signal ? 128 + (constants.signals[signal] || 0) : 1)));
