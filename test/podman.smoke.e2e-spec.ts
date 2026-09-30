/**
 * Opt-in smoke tests of the Podman Runner against a real Podman (ADR-0003). Skipped unless
 * SCANNER_SMOKE=1. They need the agent image (`podman build -t localhost/ai-scanner-agent:latest
 * containers/agent`) and network access to pull the proxy image.
 *
 * The isolation checks run a probe in place of opencode, in a container set up exactly as for an
 * Attempt, so they need no model credentials. The real Scan also needs SCANNER_MODELS (and
 * SCANNER_DEFAULT_MODEL) plus SCANNER_AGENT_ENV naming the variables holding the API keys.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppConfig, loadConfig, ModelEntry, MINUTE_MS } from '../src/config';
import { modelEndpoint, PodmanRunner, SCAN_LABEL } from '../src/podman-runner';
import { Harness, makeZip, startApp, testConfig, waitUntil } from './harness';

const enabled = process.env.SCANNER_SMOKE === '1';
const env: NodeJS.ProcessEnv = { ...process.env, SCANNER_TOKEN: 'smoke' };
const withModels = enabled && Boolean(process.env.SCANNER_MODELS);
const podman = enabled ? loadConfig({ ...env, SCANNER_MODELS: env.SCANNER_MODELS ?? '[{"id":"m","provider":"anthropic"}]' }).podman : undefined;

function smokeConfig(overrides: Partial<AppConfig> = {}): Partial<AppConfig> {
  return { runner: 'podman', podman, attemptTimeoutMs: 20 * MINUTE_MS, scanTimeoutMs: 30 * MINUTE_MS, ...overrides };
}

/** Agent containers of the Scan that still exist. */
function containersOf(scanId: string): string[] {
  const ps = spawnSync(podman!.executable, ['ps', '-aq', '--filter', `label=${SCAN_LABEL}=${scanId}`], { encoding: 'utf8' });
  return ps.stdout.split(/\s+/).filter(Boolean);
}

/** Runs `script` with Node in place of opencode; everything else is as for a real Attempt. */
class ProbeRunner extends PodmanRunner {
  constructor(
    config: AppConfig,
    private readonly script: string,
  ) {
    super(config);
  }
  protected agentCommand(): string[] {
    return ['node', '-e', this.script];
  }
}

/** Tries, from inside the agent container, everything the agent must not be able to do. */
const ISOLATION_PROBE = `
const fs = require('fs');
const net = require('net');
const result = {};
const tryWrite = (path) => { try { fs.writeFileSync(path, 'x'); return 'written'; } catch (e) { return e.code; } };
result.readWorkspace = fs.readFileSync('/workspace/src/index.js', 'utf8');
result.writeWorkspace = tryWrite('/workspace/planted.js');
result.writeRoot = tryWrite('/usr/local/bin/planted');
result.writeOutput = tryWrite('/output/probe.txt');
result.capabilities = /CapEff:\\s*(\\w+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1];
const tcp = (host, port) => new Promise((done) => {
  const s = net.connect({ host, port });
  s.setTimeout(5000, () => { s.destroy(); done('timeout'); });
  s.on('connect', () => { s.destroy(); done('connected'); });
  s.on('error', (e) => done(e.code));
});
const connect = (authority) => new Promise((done) => {
  const proxy = new URL(process.env.HTTPS_PROXY);
  const s = net.connect(Number(proxy.port), proxy.hostname, () => s.write('CONNECT ' + authority + ' HTTP/1.1\\r\\nHost: ' + authority + '\\r\\n\\r\\n'));
  s.setTimeout(10000, () => { s.destroy(); done('timeout'); });
  s.once('data', (d) => { s.destroy(); done(String(d).split('\\r\\n')[0]); });
  s.on('error', (e) => done(e.code));
});
(async () => {
  result.direct = await tcp('1.1.1.1', 443);
  result.proxyToOther = await connect('example.com:443');
  result.proxyToModel = await connect(process.argv[1] || '');
  fs.writeFileSync('/output/probe.json', JSON.stringify(result));
})();
`;

(enabled ? describe : describe.skip)('Podman Runner smoke', () => {
  jest.setTimeout(10 * MINUTE_MS);

  describe('isolation', () => {
    const model: ModelEntry = { id: 'claude-sonnet-4-5', provider: 'anthropic' };
    const overrides = smokeConfig({ models: [model], defaultModel: model.id, maxAttempts: 1 });
    /** The Runner only reads the Podman settings and the Model Pool from it. */
    const runnerConfig = testConfig('', overrides);

    let h: Harness;
    afterEach(() => h?.dispose());

    it('reads the workspace and writes only to /output, without capabilities or direct egress', async () => {
      const script = ISOLATION_PROBE.replace("process.argv[1] || ''", JSON.stringify(modelEndpoint(model)));
      h = await startApp({ runner: new ProbeRunner(runnerConfig, script), config: overrides });
      // The probe writes no Report, so the Scan fails after its one Attempt.
      await h.submit('iso', { profile: 'security' }, makeZip({ 'src/index.js': 'console.log("hi")\n' }));
      await h.waitForState('iso', 'failed', 5 * MINUTE_MS);
      const probe = JSON.parse(await readFile(join(h.dataDir, 'scans', 'iso', 'output', 'probe.json'), 'utf8'));
      expect(probe).toEqual({
        readWorkspace: 'console.log("hi")\n',
        writeWorkspace: 'EROFS',
        writeRoot: 'EROFS',
        writeOutput: 'written',
        capabilities: '0000000000000000',
        direct: expect.not.stringMatching(/^connected$/),
        proxyToOther: 'HTTP/1.1 403 Forbidden',
        proxyToModel: 'HTTP/1.1 200 Connection Established',
      });
      expect(containersOf('iso')).toEqual([]);
    });

    it('gives opencode the configuration that denies the shell and the web, and the profile skills', async () => {
      const script =
        "const run = (...args) => require('child_process').execFileSync('opencode', args, { encoding: 'utf8' });" +
        "require('fs').writeFileSync('/output/config.json', run('debug', 'config'));" +
        "require('fs').writeFileSync('/output/skills.txt', run('debug', 'skill'));";
      h = await startApp({ runner: new ProbeRunner(runnerConfig, script), config: overrides });
      await h.submit('cfg');
      await h.waitForState('cfg', 'failed', 5 * MINUTE_MS);
      const output = join(h.dataDir, 'scans', 'cfg', 'output');
      const text = await readFile(join(output, 'config.json'), 'utf8');
      const loaded = JSON.parse(text.slice(text.indexOf('{')));
      expect(loaded.permission).toMatchObject({ bash: 'deny', webfetch: 'deny', websearch: 'deny' });
      expect(loaded.model).toBe('anthropic/claude-sonnet-4-5');
      expect(await readFile(join(output, 'skills.txt'), 'utf8')).toContain('security-review');
    });

    it('removes the container of an Attempt stopped by DELETE', async () => {
      h = await startApp({ runner: new ProbeRunner(runnerConfig, 'setTimeout(() => {}, 10 * 60 * 1000)'), config: overrides });
      await h.submit('del');
      await waitUntil(() => containersOf('del').length === 1, 'the agent container');
      expect((await h.api.delete('/api/scan/del')).status).toBe(204);
      expect(containersOf('del')).toEqual([]);
    });
  });

  (withModels ? describe : describe.skip)('a real Scan', () => {
    let h: Harness;
    afterEach(() => h?.dispose());

    it('runs opencode on the Source Archive and produces a valid Report and Findings', async () => {
      const real = loadConfig(env);
      h = await startApp({
        runner: 'configured',
        config: smokeConfig({ models: real.models, defaultModel: real.defaultModel, maxAttempts: 2 }),
      });
      const vulnerable = makeZip({
        'app.js':
          "const db = require('./db');\n" +
          "require('http').createServer((req, res) => {\n" +
          "  const id = new URL(req.url, 'http://x').searchParams.get('id');\n" +
          "  db.query('SELECT * FROM users WHERE id = ' + id).then((rows) => res.end(JSON.stringify(rows)));\n" +
          '}).listen(8080);\n',
      });
      await h.submit('real', { profile: 'security' }, vulnerable);
      const status = await h.waitForState('real', ['succeeded', 'failed'], 25 * MINUTE_MS);
      expect(status).toMatchObject({ state: 'succeeded' });
      expect((await h.api.get('/api/scan/real/artifacts/report.md')).text.trim()).not.toBe('');
      const findings = (await h.api.get('/api/scan/real/artifacts/findings.json')).body;
      expect(Array.isArray(findings.findings)).toBe(true);
      expect(containersOf('real')).toEqual([]);
    }, 30 * MINUTE_MS);
  });
});
