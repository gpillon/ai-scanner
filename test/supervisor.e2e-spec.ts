import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MINUTE_MS as MINUTE } from '../src/config/app-config';
import { PREVIOUS_ATTEMPT_NOTE } from '../src/scans/scan-supervisor.service';
import {
  FakeRunner,
  Gate,
  filesOf,
  Harness,
  makeZip,
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

  /** The profiles, plus `markdown`: it has Findings but no Report template, so its agent writes report.md. */
  let profilesDir: string;
  beforeAll(async () => {
    profilesDir = await mkdtemp(join(tmpdir(), 'ai-scanner-profiles-'));
    await cp(resolve(__dirname, '..', 'profiles'), profilesDir, { recursive: true });
    await mkdir(join(profilesDir, 'markdown'));
    await writeFile(
      join(profilesDir, 'markdown', 'profile.json'),
      JSON.stringify({ name: 'markdown', description: 'Report written by the agent', producesFindings: true }),
    );
    await writeFile(join(profilesDir, 'markdown', 'prompt.md'), 'Review /workspace into /output/report.md and /output/findings.json.\n');
  });
  afterAll(() => rm(profilesDir, { recursive: true, force: true }));
  const MARKDOWN = { profile: 'markdown' };

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
      await start({ config: { profilesDir } });
      h.runner.script = scripts.perAttempt(
        scripts.writeReportOnly(REPORT),
        scripts.writeFindingsText(JSON.stringify(SAMPLE_FINDINGS)),
      );
      await h.submit('s1', MARKDOWN);
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

    it.each<[string, Script, RegExp, string?]>([
      ['writes nothing', scripts.writeNothing(), /findings\.json is missing/],
      ['writes nothing, without a Report template', scripts.writeNothing(), /report\.md is missing/, 'markdown'],
      ['writes an empty report.md', scripts.writeEmptyReport(), /report\.md is empty/, 'markdown'],
      ['writes a report.md of only whitespace', scripts.writeReportOnly(' \n\t\n'), /report\.md is empty/, 'markdown'],
      ['crashes', scripts.crash(), /crashed/],
      ['exits non-zero, even with valid Artifacts', scripts.exit(1), /exited with code 1/],
      ['writes no findings.json', scripts.writeReportOnly(), /findings\.json is missing/],
      ['writes no findings.json, without a Report template', scripts.writeReportOnly(), /findings\.json is missing/, 'markdown'],
    ])('fails after 3 Attempts when every Attempt %s', async (_name, script, reason, profile = 'security') => {
      await start({ config: { profilesDir } });
      h.runner.script = script;
      await h.submit('s1', { profile });
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

    it("stops an Attempt at the Scan's own timeout, not the server's", async () => {
      await start({ config: { attemptTimeoutMs: 20 * MINUTE, scanTimeoutMs: 600 * MINUTE } });
      h.runner.script = scripts.hang();
      await h.submit('s1', { profile: 'security', attemptTimeoutMinutes: '45' });
      await waitUntil(() => h.runner.calls.length === 1, 'the first Attempt');
      h.clock.advance(20 * MINUTE);
      await settle();
      expect(h.runner.stopCalls).toEqual([]);
      h.clock.advance(25 * MINUTE);
      await waitUntil(() => h.runner.calls.length === 2, 'the second Attempt');
      expect(h.runner.stopCalls).toEqual(['s1']);
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

    it('fails a Scan whose Attempt leaves valid Artifacts only after the Scan timeout', async () => {
      await start();
      h.runner.script = async (req, ctl) => {
        await scripts.writeReport(REPORT)(req, ctl);
        h.clock.advance(60 * MINUTE);
      };
      await h.submit('s1');
      const status = await h.waitForState('s1', 'failed');
      expect(status.failureReason).toBe('Scan timed out after 60 min');
      expect(status.artifacts).toBeUndefined();
      for (const name of ['report.md', 'report.pdf', 'findings.json']) {
        expect((await h.api.get(`/api/scan/s1/artifacts/${name}`)).status).toBe(404);
      }
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

  describe('report.pdf, without a Report template', () => {
    it('is rendered from the report.md the agent wrote, listed and downloadable on a succeeded Scan', async () => {
      await start({ config: { profilesDir } });
      h.runner.script = scripts.writeReport(REPORT);
      await h.submit('s1', MARKDOWN);
      expect((await h.waitForState('s1', 'succeeded')).artifacts).toEqual(['findings.json', 'report.md', 'report.pdf']);
      const pdf = await h.download('s1', 'report.pdf');
      expect(pdf.status).toBe(200);
      expect(pdf.contentType).toBe('application/pdf');
      expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.body.subarray(-6).toString('latin1')).toMatch(/%%EOF\s*$/);
    });

    it('renders the same report.md to the same bytes, whenever it runs', async () => {
      await start({ config: { profilesDir } });
      h.runner.script = scripts.writeReport(REPORT);
      await h.submit('s1', MARKDOWN);
      await h.waitForState('s1', 'succeeded');
      h.clock.advance(3 * 24 * 60 * MINUTE);
      await new Promise((r) => setTimeout(r, 1100)); // PDF dates have one-second precision
      await h.submit('s2', MARKDOWN);
      await h.waitForState('s2', 'succeeded');
      h.runner.script = scripts.writeReport('# Another Report\n');
      await h.submit('s3', MARKDOWN);
      await h.waitForState('s3', 'succeeded');

      const [one, two, other] = await Promise.all(['s1', 's2', 's3'].map((id) => h.download(id, 'report.pdf')));
      expect(two.body.equals(one.body)).toBe(true);
      expect(other.body.equals(one.body)).toBe(false);
    });

    it('keeps a list item on one page, never leaving its marker alone on a page of its own', async () => {
      await start({ config: { profilesDir } });
      // About 50 items fit on a page: with a marker pushed to a page of its own and its text to the
      // next at every break, the list took three times as many pages.
      h.runner.script = scripts.writeReport(Array.from({ length: 400 }, (_, i) => `- item ${i}`).join('\n'));
      await h.submit('s1', MARKDOWN);
      await h.waitForState('s1', 'succeeded');
      const pdf = await h.download('s1', 'report.pdf');
      const pages = pdf.body.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
      expect(pages).toBeGreaterThan(5);
      expect(pages).toBeLessThan(11);
    });

    it('renders a Report using the whole Markdown syntax', async () => {
      await start({ config: { profilesDir } });
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
      await h.submit('s1', MARKDOWN);
      await h.waitForState('s1', 'succeeded');
      const pdf = await h.download('s1', 'report.pdf');
      expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  });

  describe('the Report template', () => {
    const source = makeZip({ 'src/db.js': Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n' });
    const data = (findings: object[], report: object = { summary: 'Two problems.' }) => JSON.stringify({ report, findings });
    const finding = (over: object) => ({ ...SAMPLE_FINDINGS.findings[0], ...over });

    it("hands a profile's own template the agent's findings.json as it is, under `data`", async () => {
      // A profile whose Report is not about Findings: its template renders fields of its own schema.
      const dir = join(profilesDir, 'inventory');
      await mkdir(join(dir, 'report'), { recursive: true });
      await writeFile(join(dir, 'profile.json'), JSON.stringify({ name: 'inventory', description: 'Inventory', producesFindings: true }));
      await writeFile(join(dir, 'prompt.md'), 'Write /output/findings.json.\n');
      await writeFile(
        join(dir, 'report', 'schema.json'),
        JSON.stringify({ type: 'object', required: ['findings', 'report'], properties: { report: { type: 'object', required: ['items'] } } }),
      );
      await writeFile(join(dir, 'report', 'report.md.hbs'), '# Inventory\n\n{{#each data.report.items}}- {{cell this.name}}: {{this.count}}\n{{/each}}');
      await writeFile(join(dir, 'report', 'report.typ'), '#let d = json(bytes(sys.inputs.data))\n#for i in d.data.report.items [#i.name: #i.count \\ ]\n');
      try {
        await start({ config: { profilesDir } });
        h.runner.script = scripts.writeFindingsText(JSON.stringify({ findings: [], report: { items: [{ name: 'alpha', count: 2 }, { name: 'beta', count: 5 }] } }));
        await h.submit('s1', { profile: 'inventory' }, source);
        expect((await h.waitForState('s1', 'succeeded')).artifacts).toEqual(['findings.json', 'report.md', 'report.pdf']);
        expect((await h.api.get('/api/scan/s1/artifacts/report.md')).text).toBe('# Inventory\n\n- alpha: 2\n- beta: 5\n');
        expect((await h.download('s1', 'report.pdf')).body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    async function scan(json: string, id = 's1'): Promise<string> {
      h.runner.script = scripts.writeFindingsText(json);
      await h.submit(id, { profile: 'security' }, source);
      await h.waitForState(id, 'succeeded');
      return (await h.api.get(`/api/scan/${id}/artifacts/report.md`)).text;
    }

    it('fills report.md and report.pdf from findings.json alone', async () => {
      await start();
      h.runner.script = scripts.writeFindingsText(data([finding({ location: { file: 'src/db.js', line: 12 } })]));
      await h.submit('s1', { profile: 'security', language: 'it' }, source);
      expect((await h.waitForState('s1', 'succeeded')).artifacts).toEqual(['findings.json', 'report.md', 'report.pdf']);

      const md = (await h.api.get('/api/scan/s1/artifacts/report.md')).text;
      for (const heading of ['# Security Assessment Report', '## 1. Executive Summary', '## 5. Detailed Findings', '## Appendix A. Severity Scale']) {
        expect(md.split('\n')).toContain(heading);
      }
      expect(md).toContain('Two problems.');
      expect(md).toContain('| **Scan ID** | `s1` |');
      expect(md).toContain('| **Report language** | it |');
      expect(md).toContain(`| **Source Archive SHA-256** | \`${createHash('sha256').update(source).digest('hex')}\` |`);
      expect(md).toContain('| **Overall risk** | **High** |');
      expect(md).toContain('### F-001. SQL injection');
      // The evidence is read by the server from the Source Archive, around the reported line.
      expect(md).toContain(['```javascript', '    10  line 10', '    11  line 11', '>   12  line 12', '    13  line 13', '    14  line 14', '```'].join('\n'));

      const pdf = await h.download('s1', 'report.pdf');
      expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });

    it('replaces a report.md the agent wrote', async () => {
      await start();
      h.runner.script = scripts.writeReport('# My own report\n', SAMPLE_FINDINGS);
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      const md = (await h.api.get('/api/scan/s1/artifacts/report.md')).text;
      expect(md).not.toContain('My own report');
      expect(md).toMatch(/^# Security Assessment Report\n/);
    });

    it('orders the Findings by severity and numbers them', async () => {
      await start();
      const md = await scan(data([finding({ severity: 'info', title: 'Hint' }), finding({ severity: 'critical', title: 'RCE' }), finding({ severity: 'info', title: 'Tip' })]));
      expect(md).toMatch(/### F-001\. RCE[\s\S]*### F-002\. Hint[\s\S]*### F-003\. Tip/);
      expect(md).toContain('| **Overall risk** | **Critical** |');
    });

    it('rates the overall risk Minimal when only Info Findings remain', async () => {
      await start();
      expect(await scan(data([finding({ severity: 'info' })]))).toContain('| **Overall risk** | **Minimal** |');
    });

    it('shows every section, saying what the agent did not provide', async () => {
      await start();
      const md = await scan(data([]));
      expect(md).toContain('No Finding survived triage.');
      expect(md).toMatch(/## 7\. Security Strengths\n\nNot provided\./);
      expect(md).toMatch(/## 9\. Triage: Dismissed Candidates\n\nNone reported\./);
    });

    it('rejects a findings.json without the Report data', async () => {
      await start({ config: { maxAttempts: 1 } });
      h.runner.script = scripts.writeFindingsText(JSON.stringify({ findings: [] }));
      await h.submit('s1');
      const status = await h.waitForState('s1', 'failed');
      expect(status.failureReason).toMatch(/findings\.json does not match the Report template's schema: .*report/);
    });

    it('retries rather than fails when a required text is blank', async () => {
      await start({ config: { maxAttempts: 2 } });
      h.runner.script = scripts.perAttempt(
        scripts.writeFindingsText(data([finding({ title: '  ' })])),
        scripts.writeFindingsText(data([finding({ title: 'SQL injection' })])),
      );
      await h.submit('s1');
      expect(await h.waitForState('s1', 'succeeded')).toMatchObject({ attempts: 2 });
    });

    it.each([
      ['outside the workspace', '../source.zip'],
      ['absolute', '/etc/passwd'],
      ['missing', 'src/nope.js'],
    ])('shows no excerpt of a file %s', async (_name, file) => {
      await start();
      const md = await scan(data([finding({ location: { file, line: 1 } })]));
      expect(md).toContain('No excerpt: the location has no line, or the file could not be read.');
      expect(md).not.toMatch(/PK\u0003\u0004|root:/);
    });

    it('keeps the agent text from changing the structure of report.md', async () => {
      await start();
      const md = await scan(
        data([
          finding({
            title: 'Pipe | in title\nand a newline <img src=x>',
            description: 'Opens a fence:\n```\n# Injected heading\n<script>x</script>',
            recommendation: '# Another heading\n<b>html</b>\n---',
          }),
        ]),
      );
      expect(md).toContain('### F-001. Pipe \\| in title and a newline \\<img src=x>');
      expect(md).toContain('| F-001 | High | Pipe \\| in title and a newline \\<img src=x> |');
      expect(md).not.toMatch(/^# Another heading/m);
      expect(md).toContain('\\# Another heading\n\\<b>html</b>\n\\---');
      // The fence the agent left open is closed before the next section: what it holds stays code.
      expect(md).toContain('Opens a fence:\n```\n# Injected heading\n<script>x</script>\n```\n\n#### Evidence');
    });

    it('renders the same Scan to the same PDF bytes', async () => {
      await start();
      const json = data([finding({ location: { file: 'src/db.js', line: 3 } })]);
      await scan(json);
      const one = await h.download('s1', 'report.pdf');
      expect((await h.api.delete('/api/scan/s1')).status).toBe(204);
      await scan(json);
      const two = await h.download('s1', 'report.pdf');
      expect(two.body.equals(one.body)).toBe(true);
      await scan(json, 's2');
      expect((await h.download('s2', 'report.pdf')).body.equals(one.body)).toBe(false);
    });

    it("tells the agent the Report template's schema", async () => {
      await start();
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      const prompt = h.runner.calls[0].prompt;
      expect(prompt).toContain('"title": "Security Findings"');
      expect(prompt).toMatch(/"required": \[\s*"summary"\s*\]/);
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
      await waitUntil(() => h.runner.calls.length === 3, 'the queued Scan');
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
