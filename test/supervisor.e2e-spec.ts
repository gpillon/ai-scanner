import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MINUTE_MS as MINUTE } from '../src/config';
import { PREVIOUS_ATTEMPT_NOTE } from '../src/supervisor';
import {
  FakeRunner,
  Gate,
  filesOf,
  Harness,
  SAMPLE_FINDINGS,
  Script,
  scripts,
  settle,
  startApp,
  waitUntil,
} from './harness';

const REPORT = '# Security Report\n\nOne high-severity Finding.\n';

describe('Scan Supervisor', () => {
  let h: Harness;
  afterEach(() => h?.dispose());

  async function start(config: Parameters<typeof startApp>[0] = {}): Promise<Harness> {
    h = await startApp(config);
    return h;
  }

  /** Contents of every internal file kept for the Scan. */
  async function internalFiles(id: string): Promise<string[]> {
    const files = await filesOf(h.dataDir, id);
    const contents: string[] = [];
    for (const f of files) contents.push(await readFile(join(h.dataDir, f), 'utf8').catch(() => ''));
    return contents;
  }

  describe('Attempts', () => {
    it('starts a new Attempt on the same workspace when an Attempt leaves no valid Artifacts', async () => {
      await start();
      h.runner.script = scripts.perAttempt(scripts.writeNothing(), scripts.writeReport(REPORT));
      await h.submit('s1');
      const status = await h.waitForState('s1', 'succeeded');
      expect(status.attempts).toBe(2);
      const [first, second] = h.runner.calls;
      expect(second.attempt).toBe(2);
      expect(second.workspaceDir).toBe(first.workspaceDir);
      expect(second.outputDir).toBe(first.outputDir);
    });

    it('lets a new Attempt finish the partial Artifacts of the previous one', async () => {
      await start();
      h.runner.script = scripts.perAttempt(
        scripts.writeReportOnly(REPORT),
        scripts.writeFindingsText(JSON.stringify(SAMPLE_FINDINGS)),
      );
      await h.submit('s1');
      expect((await h.waitForState('s1', 'succeeded')).attempts).toBe(2);
      expect((await h.api.get('/api/scan/s1/artifacts/report.md')).text).toBe(REPORT);
      expect((await h.api.get('/api/scan/s1/artifacts/findings.json')).body).toEqual(SAMPLE_FINDINGS);
    });

    it('adds the previous-Attempt note to the prompt from the second Attempt on', async () => {
      await start();
      h.runner.script = scripts.perAttempt(scripts.writeNothing(), scripts.writeNothing(), scripts.writeReport());
      await h.submit('s1', { profile: 'security', instructions: 'focus on auth' });
      await h.waitForState('s1', 'succeeded');
      const prompts = h.runner.calls.map((c) => c.prompt);
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).not.toContain(PREVIOUS_ATTEMPT_NOTE);
      expect(prompts[1]).toContain(PREVIOUS_ATTEMPT_NOTE);
      expect(prompts[1].replace(`${PREVIOUS_ATTEMPT_NOTE}\n\n`, '')).toBe(prompts[0]);
      expect(prompts[2]).toBe(prompts[1]);
    });

    it.each<[string, Script, RegExp]>([
      ['writes nothing', scripts.writeNothing(), /report\.md is missing/],
      ['writes an empty report.md', scripts.writeEmptyReport(), /report\.md is empty/],
      ['writes a report.md of only whitespace', scripts.writeReportOnly(' \n\t\n'), /report\.md is empty/],
      ['crashes', scripts.crash(), /crashed/],
      ['exits non-zero, even with valid Artifacts', scripts.exit(1), /exited with code 1/],
      ['writes no findings.json', scripts.writeReportOnly(), /findings\.json is missing/],
    ])('fails after 3 Attempts when every Attempt %s', async (_name, script, reason) => {
      await start();
      h.runner.script = script;
      await h.submit('s1');
      const status = await h.waitForState('s1', 'failed');
      expect(status.attempts).toBe(3);
      expect(status.failureReason).toMatch(/No valid Artifacts after 3 Attempts/);
      expect(status.failureReason).toMatch(reason);
      expect(h.runner.calls).toHaveLength(3);
    });

    it('honours a configured maximum number of Attempts', async () => {
      await start({ config: { maxAttempts: 2 } });
      h.runner.script = scripts.writeNothing();
      await h.submit('s1');
      const status = await h.waitForState('s1', 'failed');
      expect(status.attempts).toBe(2);
      expect(status.failureReason).toMatch(/No valid Artifacts after 2 Attempts/);
      expect(h.runner.calls).toHaveLength(2);
    });

    it('shows the number of the Attempt in progress', async () => {
      await start();
      h.runner.script = scripts.perAttempt(scripts.writeNothing(), scripts.hang());
      await h.submit('s1');
      await waitUntil(() => h.runner.calls.length === 2, 'the second Attempt');
      const status = (await h.api.get('/api/scan/s1')).body;
      expect(status).toMatchObject({ state: 'running', attempts: 2 });
    });
  });

  describe('Findings', () => {
    it('serves findings.json exactly as the agent wrote it', async () => {
      await start();
      h.runner.script = scripts.writeReport(REPORT, { ...SAMPLE_FINDINGS, summary: 'extra fields are kept' });
      await h.submit('s1');
      expect((await h.waitForState('s1', 'succeeded')).artifacts).toContain('findings.json');
      const res = await h.api.get('/api/scan/s1/artifacts/findings.json');
      expect(res.body).toEqual({ ...SAMPLE_FINDINGS, summary: 'extra fields are kept' });
    });

    const finding = SAMPLE_FINDINGS.findings[0];
    it.each<[string, string]>([
      ['is not JSON', '{"findings": ['],
      ['is an array', JSON.stringify([finding])],
      ['has no findings list', JSON.stringify({ issues: [finding] })],
      ['has an unknown severity', JSON.stringify({ findings: [{ ...finding, severity: 'urgent' }] })],
      ['has a Finding without a title', JSON.stringify({ findings: [{ ...finding, title: undefined }] })],
      ['has a Finding with an empty description', JSON.stringify({ findings: [{ ...finding, description: '' }] })],
      ['has a Finding without a location', JSON.stringify({ findings: [{ ...finding, location: undefined }] })],
      ['has a location without a file', JSON.stringify({ findings: [{ ...finding, location: { line: 3 } }] })],
      ['has a line that is not a positive integer', JSON.stringify({ findings: [{ ...finding, location: { file: 'a', line: 0 } }] })],
      ['has a line given as a string', JSON.stringify({ findings: [{ ...finding, location: { file: 'a', line: '3' } }] })],
    ])('rejects a findings.json that %s', async (_name, text) => {
      await start({ config: { maxAttempts: 1 } });
      h.runner.script = scripts.perAttempt(async (req, ctl) => {
        await scripts.writeReportOnly(REPORT)(req, ctl);
        await scripts.writeFindingsText(text)(req, ctl);
      });
      await h.submit('s1');
      const status = await h.waitForState('s1', 'failed');
      expect(status.failureReason).toMatch(/findings\.json/);
    });

    describe('for a Scan Profile that declares no Findings', () => {
      let profilesDir: string;
      beforeAll(async () => {
        profilesDir = await mkdtemp(join(tmpdir(), 'ai-scanner-profiles-'));
        await cp(resolve(__dirname, '..', 'profiles'), profilesDir, { recursive: true });
        await mkdir(join(profilesDir, 'summary'));
        await writeFile(
          join(profilesDir, 'summary', 'profile.json'),
          JSON.stringify({ name: 'summary', description: 'Summary of the codebase', producesFindings: false }),
        );
        await writeFile(join(profilesDir, 'summary', 'prompt.md'), 'Summarise /workspace into /output/report.md.\n');
      });
      afterAll(() => rm(profilesDir, { recursive: true, force: true }));

      it('succeeds with report.md alone and never lists findings.json', async () => {
        await start({ config: { profilesDir } });
        h.runner.script = scripts.writeReport(REPORT, 'not even JSON');
        await h.submit('s1', { profile: 'summary' });
        expect((await h.waitForState('s1', 'succeeded')).artifacts).toEqual(['report.md', 'report.pdf']);
        expect((await h.api.get('/api/scan/s1/artifacts/findings.json')).status).toBe(404);
        expect(h.runner.calls[0].prompt).not.toContain('findings.json');
      });
    });

    it('tells the agent the Findings schema', async () => {
      await start();
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      expect(h.runner.calls[0].prompt).toMatch(/findings\.json.*JSON Schema/);
      expect(h.runner.calls[0].prompt).toContain('"critical"');
    });
  });

  describe('a failed Scan', () => {
    it('exposes no Artifacts, even when some of them are valid', async () => {
      await start();
      h.runner.script = scripts.perAttempt(async (req, ctl) => {
        await scripts.writeReportOnly(REPORT)(req, ctl);
        await scripts.writeFindingsText('{}')(req, ctl);
      });
      await h.submit('s1');
      const status = await h.waitForState('s1', 'failed');
      expect(status.artifacts).toBeUndefined();
      for (const name of ['report.md', 'report.pdf', 'findings.json']) {
        expect((await h.api.get(`/api/scan/s1/artifacts/${name}`)).status).toBe(404);
      }
    });

    it("keeps partial Artifacts and each Attempt's transcript internally until the Scan is deleted", async () => {
      await start();
      h.runner.script = scripts.writeReportOnly(REPORT);
      await h.submit('s1');
      await h.waitForState('s1', 'failed');
      const kept = await internalFiles('s1');
      expect(kept).toContain(REPORT);
      for (const n of [1, 2, 3]) expect(kept).toContain(`transcript of s1 Attempt ${n}\n`);

      await h.api.delete('/api/scan/s1');
      expect(await internalFiles('s1')).toEqual([]);
    });
  });

  describe('timeouts', () => {
    it('stops a hanging Attempt at the Attempt timeout and starts a new one', async () => {
      await start();
      h.runner.script = scripts.perAttempt(scripts.hang(), scripts.writeReport());
      await h.submit('s1');
      await waitUntil(() => h.runner.calls.length === 1, 'the first Attempt');

      h.clock.advance(19 * MINUTE);
      await settle();
      expect(h.runner.stopCalls).toEqual([]);
      expect(h.runner.calls).toHaveLength(1);

      h.clock.advance(1 * MINUTE);
      const status = await h.waitForState('s1', 'succeeded');
      expect(status.attempts).toBe(2);
      expect(h.runner.stopCalls).toEqual(['s1']);
    });

    it('fails the Scan when every Attempt times out', async () => {
      await start({ config: { scanTimeoutMs: 600 * MINUTE } });
      h.runner.script = scripts.hang();
      await h.submit('s1');
      for (const n of [1, 2, 3]) {
        await waitUntil(() => h.runner.calls.length === n, `Attempt ${n}`);
        h.clock.advance(20 * MINUTE);
      }
      const status = await h.waitForState('s1', 'failed');
      expect(status.attempts).toBe(3);
      expect(status.failureReason).toMatch(/No valid Artifacts after 3 Attempts.*timed out after 20 min/);
      expect(h.runner.stopCalls).toEqual(['s1', 's1', 's1']);
    });

    it('fails the Scan at the Scan timeout even when Attempts remain', async () => {
      await start({ config: { attemptTimeoutMs: 20 * MINUTE, scanTimeoutMs: 30 * MINUTE } });
      h.runner.script = scripts.hang();
      await h.submit('s1');
      await waitUntil(() => h.runner.calls.length === 1, 'the first Attempt');
      h.clock.advance(20 * MINUTE);
      await waitUntil(() => h.runner.calls.length === 2, 'the second Attempt');
      h.clock.advance(10 * MINUTE);

      const status = await h.waitForState('s1', 'failed');
      expect(status.attempts).toBe(2);
      expect(status.failureReason).toBe('Scan timed out after 30 min');
      expect(status.finishedAt).toBe('2026-01-01T00:30:00.000Z');
      expect(h.runner.calls).toHaveLength(2);
      expect(h.runner.stopCalls).toEqual(['s1', 's1']);
    });

    it('counts the Scan timeout from when the Scan starts, not while it is queued', async () => {
      await start({ config: { concurrency: 1, attemptTimeoutMs: 100 * MINUTE, scanTimeoutMs: 60 * MINUTE } });
      const gate = new Gate();
      h.runner.script = gate.script();
      await h.submit('first');
      await h.submit('second');
      await waitUntil(() => h.runner.calls.length === 1, 'the first Scan');
      h.clock.advance(50 * MINUTE);
      gate.release('first');
      await h.waitForState('first', 'succeeded');

      await waitUntil(() => h.runner.calls.length === 2, 'the second Scan');
      h.clock.advance(50 * MINUTE);
      await settle();
      expect((await h.api.get('/api/scan/second')).body.state).toBe('running');
      h.clock.advance(10 * MINUTE);
      expect((await h.waitForState('second', 'failed')).failureReason).toBe('Scan timed out after 60 min');
    });
  });

  describe('report.pdf', () => {
    it('is rendered from report.md, listed and downloadable on a succeeded Scan', async () => {
      await start();
      h.runner.script = scripts.writeReport(REPORT);
      await h.submit('s1');
      expect((await h.waitForState('s1', 'succeeded')).artifacts).toEqual(['findings.json', 'report.md', 'report.pdf']);
      const pdf = await h.download('s1', 'report.pdf');
      expect(pdf.status).toBe(200);
      expect(pdf.contentType).toBe('application/pdf');
      expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.body.subarray(-6).toString('latin1')).toMatch(/%%EOF\s*$/);
    });

    it('renders the same report.md to the same bytes, whenever it runs', async () => {
      await start();
      h.runner.script = scripts.writeReport(REPORT);
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      h.clock.advance(3 * 24 * 60 * MINUTE);
      await new Promise((r) => setTimeout(r, 1100)); // PDF dates have one-second precision
      await h.submit('s2');
      await h.waitForState('s2', 'succeeded');
      h.runner.script = scripts.writeReport('# Another Report\n');
      await h.submit('s3');
      await h.waitForState('s3', 'succeeded');

      const [one, two, other] = await Promise.all(['s1', 's2', 's3'].map((id) => h.download(id, 'report.pdf')));
      expect(two.body.equals(one.body)).toBe(true);
      expect(other.body.equals(one.body)).toBe(false);
    });

    it('renders a Report using the whole Markdown syntax', async () => {
      await start();
      const rich = [
        '# Title',
        'Text with **bold**, *italics*, `code`, [a link](https://example.com), ~~struck~~ and <b>html</b>.',
        '## Lists',
        '1. one\n2. two\n   - nested\n   - [x] done task\n   - [ ] open task',
        '> A quote\n> over two lines',
        '```ts\nconst a: number = 1;\n```',
        '| Severity | Title |\n|:--|--:|\n| high | SQL injection |',
        '---',
        '![diagram](d.png)',
        'Accents: perché, déjà vu, Übung.',
        ...Array.from({ length: 80 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum '.repeat(20)),
      ].join('\n\n');
      h.runner.script = scripts.writeReport(rich);
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      const pdf = await h.download('s1', 'report.pdf');
      expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  });

  describe('queue', () => {
    it('runs at most the configured number of Scans at once; the others stay queued', async () => {
      await start();
      const gate = new Gate();
      h.runner.script = gate.script();
      for (const id of ['a', 'b', 'c']) await h.submit(id);
      await waitUntil(() => h.runner.calls.length === 2, 'two running Scans');
      await settle();
      expect(h.runner.started()).toEqual(['a', 'b']);
      expect((await h.api.get('/api/scan/c')).body).toMatchObject({ state: 'queued', attempts: 0 });

      gate.release('a');
      await h.waitForState('a', 'succeeded');
      await h.waitForState('c', 'running');
      expect(h.runner.started()).toEqual(['a', 'b', 'c']);
    });

    it('starts queued Scans in submission order', async () => {
      await start({ config: { concurrency: 1 } });
      const gate = new Gate();
      h.runner.script = gate.script();
      const ids = ['zeta', 'alpha', 'mid', 'beta'];
      for (const id of ids) await h.submit(id);
      for (const id of ids) {
        await h.waitForState(id, 'running');
        gate.release(id);
        await h.waitForState(id, 'succeeded');
      }
      expect(h.runner.started()).toEqual(ids);
    });

    it('keeps queued Scans across a restart and fails the running one as interrupted', async () => {
      await start({ config: { concurrency: 1 } });
      h.runner.script = scripts.hang();
      for (const id of ['s1', 's2', 's3']) await h.submit(id);
      await h.waitForState('s1', 'running');
      await h.close();

      const restarted = await startApp({ dataDir: h.dataDir, runner: new FakeRunner(), config: { concurrency: 1 } });
      try {
        await restarted.waitForState('s3', 'succeeded');
        const s1 = (await restarted.api.get('/api/scan/s1')).body;
        expect(s1.state).toBe('failed');
        expect(s1.failureReason).toMatch(/interrupted/i);
        expect((await restarted.api.get('/api/scan/s2')).body.state).toBe('succeeded');
        expect(restarted.runner.started()).toEqual(['s2', 's3']);
      } finally {
        await restarted.close();
      }
    });

    it('never starts a queued Scan that was deleted, and frees its id', async () => {
      await start({ config: { concurrency: 1 } });
      const gate = new Gate();
      h.runner.script = gate.script();
      await h.submit('s1');
      await h.submit('s2');
      await h.waitForState('s1', 'running');

      expect((await h.api.delete('/api/scan/s2')).status).toBe(204);
      expect((await h.api.get('/api/scan/s2')).status).toBe(404);
      gate.release('s1');
      await h.waitForState('s1', 'succeeded');
      await settle();
      expect(h.runner.started()).toEqual(['s1']);
      expect(await filesOf(h.dataDir, 's2')).toEqual([]);

      h.runner.script = scripts.writeReport();
      expect((await h.submit('s2')).status).toBe(201);
      await h.waitForState('s2', 'succeeded');
    });

    it('starts the next queued Scan when a running one is deleted', async () => {
      await start({ config: { concurrency: 1 } });
      h.runner.script = scripts.perAttempt(scripts.hang());
      await h.submit('s1');
      await h.submit('s2');
      await h.waitForState('s1', 'running');
      h.runner.script = scripts.writeReport();
      expect((await h.api.delete('/api/scan/s1')).status).toBe(204);
      await h.waitForState('s2', 'succeeded');
    });

    it('starts no further Attempt for a Scan deleted while an Attempt ends', async () => {
      await start();
      let deletion: Promise<number> | undefined;
      h.runner.script = async () => {
        deletion = h.api.delete('/api/scan/s1').then((res) => res.status);
        await waitUntil(() => h.runner.stopCalls.includes('s1'), 'the deletion to stop the Scan');
        // ...and the Attempt ends without valid output.
      };
      await h.submit('s1');
      await waitUntil(() => deletion !== undefined, 'the deletion');
      expect(await deletion).toBe(204);
      await settle();
      expect(h.runner.calls).toHaveLength(1);
      expect((await h.api.get('/api/scan/s1')).status).toBe(404);
    });
  });
});
