import { loadConfig } from '../src/config';
import { Harness, startApp } from './harness';

const BASE_ENV = { SCANNER_TOKEN: 't', SCANNER_MODELS: JSON.stringify([{ id: 'm', provider: 'anthropic' }]) };

describe('Runner selection', () => {
  it('uses the Podman Runner unless configured otherwise', () => {
    expect(loadConfig(BASE_ENV).runner).toBe('podman');
    expect(loadConfig({ ...BASE_ENV, SCANNER_RUNNER: 'fake' }).runner).toBe('fake');
  });

  it('refuses an unknown Runner', () => {
    expect(() => loadConfig({ ...BASE_ENV, SCANNER_RUNNER: 'docker' })).toThrow(/SCANNER_RUNNER/);
  });

  describe('with the fake Runner', () => {
    let h: Harness;
    afterEach(() => h?.dispose());

    it('completes Scans with a placeholder Report, without any agent', async () => {
      h = await startApp({ runner: 'configured', config: { runner: 'fake' } });
      await h.submit('s1');
      expect((await h.waitForState('s1', 'succeeded')).artifacts).toEqual(['findings.json', 'report.md', 'report.pdf']);
      expect((await h.api.get('/api/scan/s1/artifacts/report.md')).text).toMatch(/fake Runner/);
      expect((await h.api.get('/api/scan/s1/artifacts/findings.json')).body).toEqual({
        report: { summary: expect.stringMatching(/fake Runner/) },
        findings: [],
      });
    });
  });
});
