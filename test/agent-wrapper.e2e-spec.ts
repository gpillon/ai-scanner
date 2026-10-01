import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/** The agent image's command (containers/agent/run.js), run on the host. */
const RUN = resolve(__dirname, '..', 'containers', 'agent', 'run.js');

/**
 * Stands in for opencode: prints the main session's events and writes a subagent session's parts
 * to opencode's database, the way opencode does. One tool call is still running at the first
 * poll and finishes later. Exits with 3.
 */
const FAKE_OPENCODE = `#!/usr/bin/env node
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dir = join(process.env.HOME, '.local', 'share', 'opencode');
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(join(dir, 'opencode.db'));
db.exec(\`PRAGMA journal_mode = WAL;
  CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, title TEXT, cost REAL DEFAULT 0,
    tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0,
    tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0, time_created INTEGER);
  CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, data TEXT);\`);
const part = db.prepare('INSERT OR REPLACE INTO part (id, session_id, time_updated, data) VALUES (?, ?, ?, ?)');
const put = (id, data) => part.run(id, 'child', Date.now(), JSON.stringify(data));
const putMain = (id, data) => part.run(id, 'main', Date.now(), JSON.stringify(data));
const tool = (status) => ({ type: 'tool', tool: 'grep', state: { status, input: { pattern: 'eval' } } });
const task = (status) => ({ type: 'tool', tool: 'task', state: { status, input: { description: 'Injection' } } });
db.prepare("INSERT INTO session VALUES ('main', NULL, 'build', 'scan', 0, 100, 10, 0, 0, 0, 1)").run();
db.prepare("INSERT INTO session VALUES ('child', 'main', 'reviewer', 'Injection (@reviewer subagent)', 0, 50, 5, 0, 0, 0, 2)").run();
console.log(JSON.stringify({ type: 'text', sessionID: 'main', part: { type: 'text', text: 'Starting reviewers' } }));
put('p1', { type: 'step-start' });
put('p2', { type: 'reasoning', text: 'hidden' });
put('p3', tool('completed'));
put('p4', tool('running'));
put('p5', { type: 'text', text: 'not finished', time: { start: 1 } });
putMain('t1', task('running'));
setTimeout(() => {
  put('p4', tool('completed'));
  put('p5', { type: 'text', text: 'Found nothing', time: { start: 1, end: 2 } });
  put('p6', { type: 'step-finish', tokens: { total: 55 } });
  putMain('t1', task('completed'));
  console.log(JSON.stringify({ type: 'text', sessionID: 'main', part: { type: 'text', text: 'Merging' } }));
  process.exitCode = 3;
}, 2500);
`;

/**
 * Stands in for opencode when a subagent session goes nowhere, and never exits on its own. With
 * FAKE_MODE=empty, the model answers with nothing: steps with no output and no finish reason.
 * With FAKE_MODE=loop, it reads the same missing file again and again.
 */
const STALLING_OPENCODE = `#!/usr/bin/env node
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dir = join(process.env.HOME, '.local', 'share', 'opencode');
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(join(dir, 'opencode.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, title TEXT, cost REAL DEFAULT 0, ' +
  'tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0, ' +
  'tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0, time_created INTEGER)');
db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, data TEXT)');
db.prepare("INSERT INTO session VALUES ('main', NULL, 'build', 'scan', 0, 0, 0, 0, 0, 0, 1)").run();
db.prepare("INSERT INTO session VALUES ('child', 'main', 'reviewer', 'Stuck (@reviewer subagent)', 0, 0, 0, 0, 0, 0, 2)").run();
const part = db.prepare('INSERT INTO part (id, session_id, time_updated, data) VALUES (?, ?, ?, ?)');
let n = 0;
setInterval(() => {
  n++;
  const data = process.env.FAKE_MODE === 'loop'
    ? { type: 'tool', tool: 'read', state: { status: 'error', input: { filePath: '/skills/x/missing.md' }, error: 'File not found' } }
    : { type: 'step-finish', reason: 'unknown', tokens: { total: 344580, output: 0 } };
  part.run('s' + n, 'child', Date.now(), JSON.stringify(data));
}, 50);
`;

(process.platform === 'win32' ? describe.skip : describe)('Agent wrapper (containers/agent/run.js)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-wrapper-'));
    writeFileSync(join(dir, 'opencode'), FAKE_OPENCODE);
    chmodSync(join(dir, 'opencode'), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the subagents' finished parts to opencode's stream, then the usage line, and keeps opencode's exit code", () => {
    const run = spawnSync(process.execPath, ['--no-warnings', RUN, 'run', '--format', 'json'], {
      env: { ...process.env, HOME: dir, PATH: `${dir}${delimiter}${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(run.status).toBe(3);
    const events = run.stdout.trim().split('\n').map((l) => JSON.parse(l));

    const main = events.filter((e) => e.sessionID === 'main').map((e) => e.part.text);
    expect(main).toEqual(['Starting reviewers', 'Merging']);

    const sub = events.filter((e) => e.subagent && e.part);
    for (const e of sub) expect(e).toMatchObject({ sessionID: 'child', subagent: 'Injection (@reviewer subagent)' });
    // Each finished part once, as opencode would print it; unfinished, reasoning and step-start parts never.
    expect(sub.map((e) => [e.type, e.part.id])).toEqual(
      expect.arrayContaining([
        ['tool_use', 'p3'],
        ['tool_use', 'p4'],
        ['text', 'p5'],
        ['step_finish', 'p6'],
      ]),
    );
    expect(sub).toHaveLength(4);
    expect(sub.find((e) => e.part.id === 'p5').part.text).toBe('Found nothing');

    // The main session's `task` call: a started line when it runs, a finished line when it ends.
    const task = events.filter((e) => e.type === 'subagent');
    expect(task.map((e) => e.state)).toEqual(['started', 'finished']);
    expect(task[0]).toMatchObject({ state: 'started', subagent: 'Injection', active: 1 });
    expect(task[1]).toMatchObject({ state: 'finished', ok: true, subagent: 'Injection', active: 0 });

    const usage = events[events.length - 1];
    expect(usage).toMatchObject({ type: 'usage', tokens: { input: 150, output: 15 } });
    expect(usage.sessions).toHaveLength(2);
  });

  it.each([
    ['ending its steps with nothing', 'empty', 'StalledModel'],
    ['calling one tool with the same input', 'loop', 'LoopingModel'],
  ])('stops opencode when a session keeps %s, and exits non-zero', (_what, mode, name) => {
    const stallDir = mkdtempSync(join(tmpdir(), 'agent-wrapper-stall-'));
    try {
      writeFileSync(join(stallDir, 'opencode'), STALLING_OPENCODE);
      chmodSync(join(stallDir, 'opencode'), 0o755);
      const run = spawnSync(process.execPath, ['--no-warnings', RUN, 'run', '--format', 'json'], {
        env: { ...process.env, HOME: stallDir, PATH: `${stallDir}${delimiter}${process.env.PATH}`, FAKE_MODE: mode },
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(run.signal).toBeNull(); // the wrapper ended it, not the test's timeout
      expect(run.status).not.toBe(0);
      const events = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
      const error = events.find((e) => e.type === 'error');
      expect(error).toMatchObject({ sessionID: 'child', subagent: 'Stuck (@reviewer subagent)', error: { name } });
      expect(events[events.length - 1].type).toBe('usage');
    } finally {
      rmSync(stallDir, { recursive: true, force: true });
    }
  });
});
