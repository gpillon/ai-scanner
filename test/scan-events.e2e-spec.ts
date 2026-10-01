import { appendFile } from 'node:fs/promises';
import { summarise } from '../src/scans/activity';
import { Gate, Harness, Script, scripts, startApp } from './harness';

const NOW = () => new Date('2026-01-01T00:00:00.000Z');

/** One line of `opencode run --format json`. */
const line = (type: string, part: object, timestamp = 1_767_225_600_000) => `${JSON.stringify({ type, timestamp, part })}\n`;
const readEvent = (path: string) => line('tool_use', { tool: 'read', state: { status: 'completed', input: { filePath: path }, output: 'SECRET FILE BODY' } });
const textEvent = (text: string) => line('text', { text });

interface Event {
  type: string;
  data: any;
}

/** Appends transcript lines, then runs `then`. */
const writes =
  (lines: string[], then: Script = scripts.writeReport()): Script =>
  async (req, ctl) => {
    for (const l of lines) await appendFile(req.transcriptPath, l);
    return then(req, ctl);
  };

describe('Scan activity', () => {
  describe('summarise', () => {
    it('names the tool and what it acted on, relative to the code', () => {
      expect(summarise(readEvent('/workspace/src/db.js'), 1, NOW)).toEqual({
        attempt: 1,
        at: '2026-01-01T00:00:00.000Z',
        kind: 'tool',
        tool: 'read',
        ok: true,
        text: 'src/db.js',
      });
      const grep = line('tool_use', { tool: 'grep', state: { status: 'completed', input: { pattern: 'eval\\(', path: '/workspace' } } });
      expect(summarise(grep, 2, NOW)).toMatchObject({ attempt: 2, tool: 'grep', text: 'eval\\( in .' });
      const write = line('tool_use', { tool: 'write', state: { status: 'completed', input: { filePath: '/output/findings.json', content: '{}' } } });
      expect(summarise(write, 1, NOW)).toMatchObject({ tool: 'write', text: 'output/findings.json' });
    });

    it('never carries tool output, such as skill contents or file bodies', () => {
      const skill = line('tool_use', { tool: 'skill', state: { status: 'completed', input: { name: 'security-review' }, output: 'SKILL BODY' } });
      expect(JSON.stringify(summarise(skill, 1, NOW))).not.toContain('SKILL BODY');
      expect(JSON.stringify(summarise(readEvent('/workspace/a.js'), 1, NOW))).not.toContain('SECRET FILE BODY');
    });

    it('reports failed tool calls, text, token use, errors and log lines', () => {
      const failed = line('tool_use', { tool: 'read', state: { status: 'error', input: { filePath: '/etc/passwd' }, error: 'denied' } });
      expect(summarise(failed, 1, NOW)).toMatchObject({ ok: false, text: '/etc/passwd — denied' });
      expect(summarise(textEvent('  Looking at auth.  '), 1, NOW)).toMatchObject({ kind: 'text', text: 'Looking at auth.' });
      expect(summarise(textEvent('\n'), 1, NOW)).toBeUndefined();
      expect(summarise(line('step_finish', { tokens: { total: 7514 } }), 1, NOW)).toMatchObject({ kind: 'step', text: '7514 tokens' });
      const error = JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'rate limited' } } });
      expect(summarise(error, 1, NOW)).toMatchObject({ kind: 'error', text: 'rate limited' });
      expect(summarise('podman: something odd', 1, NOW)).toMatchObject({ kind: 'log', text: 'podman: something odd' });
      expect(summarise(line('step_start', {}), 1, NOW)).toBeUndefined();
    });

    it('names the subagent that did it, by its task description', () => {
      const event = (subagent: unknown) =>
        JSON.stringify({ type: 'tool_use', timestamp: 1_767_225_600_000, subagent, part: { tool: 'grep', state: { status: 'completed', input: { pattern: 'exec' } } } });
      expect(summarise(event('Injection and data flow (@reviewer subagent)'), 1, NOW)).toMatchObject({
        kind: 'tool',
        tool: 'grep',
        text: 'exec',
        subagent: 'Injection and data flow',
      });
      expect(summarise(readEvent('/workspace/a.js'), 1, NOW)).not.toHaveProperty('subagent');
      expect(summarise(event(42), 1, NOW)).not.toHaveProperty('subagent');
    });

    it('shows a subagent starting and finishing, with how many are still active', () => {
      const subagentLine = (state: string, active: number, ok?: boolean) => {
        const event: Record<string, unknown> = { type: 'subagent', timestamp: 1_767_225_600_000, state, subagent: 'Injection', active };
        if (ok !== undefined) event.ok = ok;
        return JSON.stringify(event);
      };
      expect(summarise(subagentLine('started', 2), 1, NOW)).toEqual({
        attempt: 1,
        at: '2026-01-01T00:00:00.000Z',
        kind: 'subagent',
        subagent: 'Injection',
        active: 2,
        text: 'started (2 active)',
      });
      expect(summarise(subagentLine('finished', 1, true), 1, NOW)).toEqual({
        attempt: 1,
        at: '2026-01-01T00:00:00.000Z',
        kind: 'subagent',
        subagent: 'Injection',
        active: 1,
        ok: true,
        text: 'finished (1 active)',
      });
      expect(summarise(subagentLine('finished', 0, false), 1, NOW)).toEqual({
        attempt: 1,
        at: '2026-01-01T00:00:00.000Z',
        kind: 'subagent',
        subagent: 'Injection',
        active: 0,
        ok: false,
        text: 'failed (0 active)',
      });
    });

    it('names the subagent a task call started, by its description', () => {
      const taskRow = line('tool_use', { tool: 'task', state: { status: 'completed', input: { description: 'Injection and data flow' } } });
      expect(summarise(taskRow, 1, NOW)).toMatchObject({ kind: 'tool', tool: 'task', text: 'Injection and data flow' });
    });
  });

  describe('GET /api/scan/<id>/events', () => {
    let h: Harness;
    beforeEach(async () => {
      h = await startApp();
    });
    afterEach(() => h.dispose());

    /** The whole stream, which ends once the Scan has finished. */
    async function events(id: string): Promise<{ status: number; type: string; events: Event[] }> {
      const res = await h.api
        .get(`/api/scan/${id}/events`)
        .buffer(true)
        .parse((stream, done) => {
          let body = '';
          stream.setEncoding('utf8');
          stream.on('data', (c: string) => (body += c));
          stream.on('end', () => done(null, body));
        });
      const parsed = String(res.body)
        .split('\n\n')
        .filter((block) => block.trim())
        .map((block) => {
          const field = (name: string) => block.split('\n').find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
          return { type: field('event') ?? 'message', data: JSON.parse(field('data') ?? 'null') };
        });
      return { status: res.status, type: res.headers['content-type'], events: parsed };
    }

    const activities = (evs: Event[]) => evs.filter((e) => e.type === 'activity').map((e) => `${e.data.attempt}:${e.data.tool ?? e.data.kind}:${e.data.text}`);

    it('replays a finished Scan, then ends with its final state', async () => {
      h.runner.script = writes([readEvent('/workspace/src/db.js'), textEvent('Found a SQL injection.')]);
      await h.submit('done');
      await h.waitForState('done', 'succeeded');

      const res = await events('done');
      expect(res.status).toBe(200);
      expect(res.type).toMatch(/^text\/event-stream/);
      expect(res.events[0]).toEqual({ type: 'attempt', data: { attempt: 1 } });
      expect(activities(res.events)).toEqual(['1:log:transcript of done Attempt 1', '1:read:src/db.js', '1:text:Found a SQL injection.']);
      const last = res.events.at(-1)!;
      expect(last.type).toBe('state');
      expect(last.data).toEqual((await h.api.get('/api/scan/done')).body);
    });

    it('follows a running Scan as the agent works, until it finishes', async () => {
      const gate = new Gate();
      h.runner.script = writes([readEvent('/workspace/before.js')], async (req, ctl) => {
        await gate.script(async () => undefined)(req, ctl);
        await appendFile(req.transcriptPath, readEvent('/workspace/after.js'));
        await scripts.writeReport()(req, ctl);
      });
      await h.submit('live');
      await h.waitForState('live', 'running');

      const stream = events('live');
      setTimeout(() => gate.release('live'), 600);
      const res = await stream;

      // A `state` event per status change: `attempts` changes while the Scan is running, too.
      const states = res.events.filter((e) => e.type === 'state').map((e) => e.data.state);
      expect(states[0]).toBe('running');
      expect(states.at(-1)).toBe('succeeded');
      expect(new Set(states)).toEqual(new Set(['running', 'succeeded']));
      expect(activities(res.events)).toEqual(['1:log:transcript of live Attempt 1', '1:read:before.js', '1:read:after.js']);
    });

    it('tells the Attempts of a retried Scan apart', async () => {
      h.runner.script = scripts.perAttempt(writes([textEvent('first try')], scripts.writeNothing()), writes([textEvent('second try')]));
      await h.submit('retry');
      await h.waitForState('retry', 'succeeded');

      const res = await events('retry');
      expect(res.events.filter((e) => e.type === 'attempt').map((e) => e.data.attempt)).toEqual([1, 2]);
      expect(activities(res.events).filter((a) => a.includes(':text:'))).toEqual(['1:text:first try', '2:text:second try']);
    });

    it('is 404 for an unknown Scan', async () => {
      const res = await h.api.get('/api/scan/nope/events');
      expect(res.status).toBe(404);
    });
  });
});
