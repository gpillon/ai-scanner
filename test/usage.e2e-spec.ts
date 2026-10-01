import { appendFile } from 'node:fs/promises';
import { summarise } from '../src/scans/activity';
import { NO_USAGE, parseUsageLine } from '../src/runner/usage';
import { Harness, Script, scripts, startApp } from './harness';

/** The last line the agent container prints (containers/agent/usage.js). */
const usageLine = (input: number, output: number, cacheRead = 0, subagents = 0) =>
  JSON.stringify({
    type: 'usage',
    tokens: { input, output, reasoning: 0, cacheRead, cacheWrite: 0, total: input + output + cacheRead },
    cost: 0,
    sessions: [{ agent: 'build', subagent: false }, ...Array.from({ length: subagents }, () => ({ agent: 'reviewer', subagent: true }))],
  });

/** An Attempt that reports its usage, then does what `then` does. */
const reporting =
  (line: string, then: Script = scripts.writeReport()): Script =>
  async (req, ctl) => {
    await appendFile(req.transcriptPath, `${line}\n`);
    return then(req, ctl);
  };

describe('Token usage', () => {
  it('reads the usage line, counting the sessions', () => {
    expect(parseUsageLine(usageLine(100, 20, 5000, 2))).toEqual({
      input: 100,
      output: 20,
      reasoning: 0,
      cacheRead: 5000,
      cacheWrite: 0,
      total: 5120,
      cost: 0,
      sessions: 3,
    });
    expect(parseUsageLine('{"type":"step_finish"}')).toBeUndefined();
    expect(parseUsageLine('{"type":"usage", broken')).toBeUndefined();
  });

  it('shows the usage line in the activity as the Attempt total', () => {
    const activity = summarise(usageLine(1200, 340, 18000, 2), 1, () => new Date('2026-01-01T00:00:00Z'));
    expect(activity).toMatchObject({ attempt: 1, kind: 'step' });
    expect(activity!.text).toBe('Attempt total: 19,540 tokens (input 1,200, output 340, cache read 18,000), 3 sessions (2 subagents)');
  });

  describe('of a Scan', () => {
    let h: Harness;
    afterEach(() => h?.dispose());

    it('is summed over its Attempts and given by GET /api/scan/<id>', async () => {
      h = await startApp();
      h.runner.script = scripts.perAttempt(reporting(usageLine(1000, 200, 5000, 1), scripts.writeNothing()), reporting(usageLine(300, 50)));
      await h.submit('s1');
      const status = await h.waitForState('s1', 'succeeded');
      expect(status.attempts).toBe(2);
      expect(status.usage).toEqual({ input: 1300, output: 250, reasoning: 0, cacheRead: 5000, cacheWrite: 0, total: 6550, cost: 0, sessions: 3 });
    });

    it('is given for a failed Scan too', async () => {
      h = await startApp({ config: { maxAttempts: 1 } });
      h.runner.script = reporting(usageLine(10, 5), scripts.writeNothing());
      await h.submit('s1');
      expect((await h.waitForState('s1', 'failed')).usage).toMatchObject({ input: 10, output: 5, total: 15 });
    });

    it('is absent while no Attempt has reported it', async () => {
      h = await startApp();
      await h.submit('s1');
      expect((await h.waitForState('s1', 'succeeded')).usage).toBeUndefined();
      expect(NO_USAGE.total).toBe(0);
    });

    it('never appears in the Report or the Findings', async () => {
      h = await startApp();
      h.runner.script = reporting(usageLine(4242, 2424));
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      const report = (await h.api.get('/api/scan/s1/artifacts/report.md')).text;
      const findings = (await h.api.get('/api/scan/s1/artifacts/findings.json')).text;
      for (const text of [report, findings]) {
        expect(text).not.toMatch(/4242|4,242|tokens/i);
      }
    });
  });
});
