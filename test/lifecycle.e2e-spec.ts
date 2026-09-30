import { FakeRunner, Harness, listFiles, scripts, startApp } from './harness';

describe('Scan lifecycle', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startApp();
  });
  afterEach(() => h.dispose());

  describe('status', () => {
    it('gives 404 for an unknown id', async () => {
      expect((await h.api.get('/api/scan/nope')).status).toBe(404);
    });

    it('a succeeded Scan lists its Artifacts and has run one Attempt', async () => {
      await h.submit('s1');
      const status = await h.waitForState('s1', 'succeeded');
      expect(status).toMatchObject({
        id: 's1',
        attempts: 1,
        artifacts: ['findings.json', 'report.md', 'report.pdf'],
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(status.failureReason).toBeUndefined();
    });

    it('a running Scan has started and exposes no Artifacts', async () => {
      h.runner.script = scripts.hang();
      await h.submit('s1');
      const status = await h.waitForState('s1', 'running');
      expect(status.startedAt).not.toBeNull();
      expect(status.artifacts).toBeUndefined();
    });
  });

  describe('Artifacts', () => {
    it('downloads report.md with the Markdown content type', async () => {
      h.runner.script = scripts.writeReport('# Findings\n\nNone.\n');
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      const res = await h.api.get('/api/scan/s1/artifacts/report.md');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(res.text).toBe('# Findings\n\nNone.\n');
    });

    it('downloads findings.json with the JSON content type', async () => {
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      const res = await h.api.get('/api/scan/s1/artifacts/findings.json');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.body).toEqual({ findings: [] });
    });

    it.each(['..%2F..%2Fscanner.sqlite', 'source.zip', 'other.txt'])('gives 404 for %s', async (name) => {
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      expect((await h.api.get(`/api/scan/s1/artifacts/${name}`)).status).toBe(404);
    });

    it('gives 404 for Artifacts of a Scan that is not done', async () => {
      h.runner.script = scripts.hang();
      await h.submit('s1');
      await h.waitForState('s1', 'running');
      expect((await h.api.get('/api/scan/s1/artifacts/report.md')).status).toBe(404);
    });

    it('gives 404 for Artifacts of an unknown Scan', async () => {
      expect((await h.api.get('/api/scan/nope/artifacts/report.md')).status).toBe(404);
    });
  });

  describe('a Scan without a valid Report', () => {
    it.each([
      ['writes nothing', scripts.writeNothing()],
      ['writes an empty report.md', scripts.writeEmptyReport()],
      ['crashes', scripts.crash()],
    ])('fails when the agent %s, and exposes no Artifacts', async (_name, script) => {
      h.runner.script = script;
      await h.submit('s1');
      const status = await h.waitForState('s1', 'failed');
      expect(status.failureReason).toEqual(expect.any(String));
      expect(status.artifacts).toBeUndefined();
      expect(status.attempts).toBe(3);
      expect((await h.api.get('/api/scan/s1/artifacts/report.md')).status).toBe(404);
    });
  });

  describe('deleting', () => {
    it('removes a finished Scan with all its data and frees the id', async () => {
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      expect((await h.api.delete('/api/scan/s1')).status).toBe(204);
      expect((await h.api.get('/api/scan/s1')).status).toBe(404);
      expect((await h.api.get('/api/scan/s1/artifacts/report.md')).status).toBe(404);
      expect((await listFiles(h.dataDir)).filter((f) => f.includes('s1'))).toEqual([]);
      expect((await h.submit('s1')).status).toBe(201);
    });

    it('removes a failed Scan', async () => {
      h.runner.script = scripts.writeNothing();
      await h.submit('s1');
      await h.waitForState('s1', 'failed');
      expect((await h.api.delete('/api/scan/s1')).status).toBe(204);
      expect((await h.api.get('/api/scan/s1')).status).toBe(404);
    });

    it('stops a running Attempt through the Runner, then removes the Scan', async () => {
      h.runner.script = scripts.hang();
      await h.submit('s1');
      await h.waitForState('s1', 'running');
      expect((await h.api.delete('/api/scan/s1')).status).toBe(204);
      expect(h.runner.stopCalls).toContain('s1');
      expect((await h.api.get('/api/scan/s1')).status).toBe(404);
      expect((await listFiles(h.dataDir)).filter((f) => f.includes('s1'))).toEqual([]);
    });

    it('removes a Scan deleted right after submission, whether or not it had started', async () => {
      h.runner.script = scripts.hang();
      await h.submit('s1');
      expect((await h.api.delete('/api/scan/s1')).status).toBe(204);
      await new Promise((r) => setTimeout(r, 50));
      expect((await h.api.get('/api/scan/s1')).status).toBe(404);
      expect((await listFiles(h.dataDir)).filter((f) => f.includes('s1'))).toEqual([]);
      expect((await h.submit('s1')).status).toBe(201);
    });

    it('lets the id be reused right away after stopping a running Scan', async () => {
      h.runner.script = scripts.hang();
      await h.submit('s1');
      await h.waitForState('s1', 'running');
      await h.api.delete('/api/scan/s1');
      h.runner.script = scripts.writeReport();
      expect((await h.submit('s1')).status).toBe(201);
      expect((await h.waitForState('s1', 'succeeded')).artifacts).toContain('report.md');
    });

    it('gives 404 for an unknown id', async () => {
      expect((await h.api.delete('/api/scan/nope')).status).toBe(404);
    });
  });

  describe('retention', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('keeps Scans younger than the retention period', async () => {
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      h.clock.advance(364 * DAY);
      await h.sweeper.sweep();
      expect((await h.api.get('/api/scan/s1')).status).toBe(200);
    });

    it('makes an expired Scan behave like a deleted one', async () => {
      await h.submit('s1');
      await h.waitForState('s1', 'succeeded');
      await h.submit('s2');
      await h.waitForState('s2', 'succeeded');
      h.clock.advance(366 * DAY);
      await h.submit('fresh');
      await h.waitForState('fresh', 'succeeded');

      await h.sweeper.sweep();

      expect((await h.api.get('/api/scan/s1')).status).toBe(404);
      expect((await h.api.get('/api/scan/s2')).status).toBe(404);
      expect((await h.api.get('/api/scan/s1/artifacts/report.md')).status).toBe(404);
      expect((await h.api.get('/api/scan/fresh')).status).toBe(200);
      expect((await listFiles(h.dataDir)).filter((f) => /\bs[12]\b/.test(f))).toEqual([]);
      expect((await h.submit('s1')).status).toBe(201);
    });

    it('expires a Scan that is still running, stopping it', async () => {
      h.runner.script = scripts.hang();
      await h.submit('s1');
      await h.waitForState('s1', 'running');
      h.clock.advance(366 * DAY);
      await h.sweeper.sweep();
      expect(h.runner.stopCalls).toContain('s1');
      expect((await h.api.get('/api/scan/s1')).status).toBe(404);
    });
  });

  describe('server restart', () => {
    it('fails a Scan that was running as interrupted', async () => {
      h.runner.script = scripts.hang();
      await h.submit('s1');
      await h.waitForState('s1', 'running');
      await h.close();

      const restarted = await startApp({ dataDir: h.dataDir, runner: new FakeRunner() });
      try {
        const status = await restarted.api.get('/api/scan/s1');
        expect(status.body.state).toBe('failed');
        expect(status.body.failureReason).toMatch(/restart/i);
      } finally {
        await restarted.close();
      }
    });
  });
});
