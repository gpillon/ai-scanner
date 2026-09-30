/**
 * The PoC acceptance gate (#6): end-to-end scenarios against the built server, run as its own
 * process with the Podman Runner, the `security` Scan Profile and a real model. Skipped unless
 * SCANNER_GATE=1. It needs what the Podman smoke tests need (see there), and SCANNER_MODELS
 * (with SCANNER_DEFAULT_MODEL and SCANNER_AGENT_ENV as needed) naming a real model the egress
 * proxy can reach: without one, the scenarios that need it are skipped and the gate is not passed.
 *
 * Next to the real model, the Model Pool holds two models scripted by test/mock-llm.js, whose
 * Attempts succeed at once, or never end: the scenarios about the Scan lifecycle run on them.
 * Each scenario group starts its own server, one at a time, as they share the egress proxy.
 * Evidence (Scan statuses, the Reports and PDFs, server logs) goes to SCANNER_GATE_EVIDENCE,
 * by default docs/gate/<today>; scans.json maps each scenario to its Scan ids.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, ModelEntry, MINUTE_MS } from '../src/config';
import { paths } from '../src/paths';
import { filesOf, makeZip, waitUntil } from './harness';
import { containersOf, removeAgentContainers, scriptedModel, startScriptedModel, stopScriptedModel } from './podman';
import {
  CLEAN_APP,
  Finding,
  findingFile,
  fixtureFiles,
  highSeverity,
  looksItalian,
  missedPlanted,
  VULNERABLE_APP,
} from './real-scan';
import { buildServer, ServerProcess } from './server-process';

const enabled = process.env.SCANNER_GATE === '1';
const TOKEN = 'gate-token';

const realModels: ModelEntry[] = enabled && process.env.SCANNER_MODELS ? JSON.parse(process.env.SCANNER_MODELS) : [];
const SCRIPTED = scriptedModel('scripted');
const SCRIPTED_ALT = scriptedModel('scripted-alt');
const pool = [...realModels, SCRIPTED, SCRIPTED_ALT];
const defaultModel = realModels.length ? (process.env.SCANNER_DEFAULT_MODEL ?? realModels[0].id) : SCRIPTED.id;
const podman = loadConfig({ ...process.env, SCANNER_TOKEN: TOKEN, SCANNER_MODELS: JSON.stringify(pool), SCANNER_DEFAULT_MODEL: defaultModel }).podman;

const EVIDENCE = resolve(process.env.SCANNER_GATE_EVIDENCE ?? join(__dirname, '..', 'docs', 'gate', new Date().toISOString().slice(0, 10)));

/** Scans of the scripted model: one writes its Report at once, the other's Attempts never end. */
const SCRIPTED_SCAN = { profile: 'security', model: SCRIPTED.id };
const HANG = 'HANG-PROBE';
const HANGING_SCAN = { profile: 'security', model: SCRIPTED.id, instructions: HANG };
const ENDED = ['succeeded', 'failed'];
const SOURCE = makeZip({ 'app.js': 'console.log(1)\n' });

/** Scan ids by the scenario that ran them. */
const scenarios: Record<string, string[]> = {};

/**
 * Saves the Scan's status, and the named Artifacts and the Attempt transcripts, as evidence of the
 * current scenario, under the Scan id or `as` when a scenario keeps the same id twice.
 */
async function saveEvidence(
  server: ServerProcess,
  status: { id: string },
  extra: { as?: string; artifacts?: string[]; transcriptsFrom?: string } = {},
) {
  const label = extra.as ?? status.id;
  const dir = join(EVIDENCE, 'scans', label);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'status.json'), JSON.stringify(status, null, 2) + '\n');
  for (const name of extra.artifacts ?? []) {
    const reply = await server.request('GET', `/api/scan/${status.id}/artifacts/${name}`);
    if (reply.status === 200) await writeFile(join(dir, name), reply.bytes);
  }
  if (extra.transcriptsFrom) {
    const attempts = join(paths.scanDir(extra.transcriptsFrom, status.id), 'attempts');
    for (const attempt of existsSync(attempts) ? await readdir(attempts) : []) {
      await copyFile(paths.transcript(extra.transcriptsFrom, status.id, Number(attempt)), join(dir, `transcript-${attempt}.log`));
    }
  }
  (scenarios[expect.getState().currentTestName!] ??= []).push(label);
}

/** Runs a server for the enclosing describe, on its own data directory, with `env` over the gate's configuration. */
function withServer(name: string, env: Record<string, string> = {}) {
  const ctx = {} as { server: ServerProcess; dataDir: string; restart(): Promise<void> };
  let serverEnv: Record<string, string>;
  const start = async () => (ctx.server = await ServerProcess.start(serverEnv, join(EVIDENCE, `server-${name}.log`)));
  ctx.restart = async () => {
    await ctx.server.kill();
    await start();
  };
  beforeAll(async () => {
    ctx.dataDir = await mkdtemp(join(tmpdir(), `ai-scanner-gate-${name}-`));
    serverEnv = {
      SCANNER_TOKEN: TOKEN,
      SCANNER_RUNNER: 'podman',
      SCANNER_MODELS: JSON.stringify(pool),
      SCANNER_DEFAULT_MODEL: defaultModel,
      SCANNER_DATA_DIR: ctx.dataDir,
      SCANNER_SWEEP_INTERVAL_MINUTES: '0',
      SCANNER_MAX_EXTRACTED_MB: '8',
      SCANNER_CONCURRENCY: '2',
      SCANNER_MAX_ATTEMPTS: '1',
      ...env,
    };
    await start();
  });
  afterAll(async () => {
    await ctx.server?.kill();
    // A killed server leaves its agent containers behind.
    removeAgentContainers(podman);
    await rm(ctx.dataDir, { recursive: true, force: true });
  });
  return ctx;
}

const waitForContainer = (scanId: string) =>
  waitUntil(() => containersOf(podman, scanId).length > 0, `the agent container of ${scanId}`, 2 * MINUTE_MS, 500);

(enabled ? describe : describe.skip)('PoC gate (#6)', () => {
  jest.setTimeout(10 * MINUTE_MS);

  beforeAll(async () => {
    buildServer();
    await mkdir(EVIDENCE, { recursive: true });
    removeAgentContainers(podman);
    startScriptedModel(podman);
  });
  afterAll(async () => {
    stopScriptedModel(podman);
    await writeFile(join(EVIDENCE, 'scans.json'), JSON.stringify(scenarios, null, 2) + '\n');
  });

  describe('access and the Model Pool', () => {
    const s = withServer('access');

    it('answers 401 without the bearer token or with a wrong one', async () => {
      const endpoints = [
        ['GET', '/api/profiles'],
        ['GET', '/api/models'],
        ['POST', '/api/scan/auth'],
        ['GET', '/api/scan/auth'],
        ['GET', '/api/scan/auth/artifacts/report.md'],
        ['DELETE', '/api/scan/auth'],
      ];
      for (const [method, path] of endpoints) {
        expect([method, path, (await s.server.request(method, path, { token: null })).status]).toEqual([method, path, 401]);
        expect([method, path, (await s.server.request(method, path, { token: 'wrong' })).status]).toEqual([method, path, 401]);
      }
    });

    it('answers 404 for an unknown Scan', async () => {
      expect((await s.server.request('GET', '/api/scan/unknown')).status).toBe(404);
      expect((await s.server.request('GET', '/api/scan/unknown/artifacts/report.md')).status).toBe(404);
      expect((await s.server.request('DELETE', '/api/scan/unknown')).status).toBe(404);
    });

    it('answers 409 for an id already in use, before and after its Scan ends', async () => {
      expect((await s.server.submit('duplicate', SCRIPTED_SCAN, SOURCE)).status).toBe(201);
      expect((await s.server.submit('duplicate', SCRIPTED_SCAN, SOURCE)).status).toBe(409);
      const status = await s.server.waitForState('duplicate', ENDED, 5 * MINUTE_MS);
      await saveEvidence(s.server, status);
      expect((await s.server.submit('duplicate', SCRIPTED_SCAN, SOURCE)).status).toBe(409);
    });

    it('refuses a model outside the Model Pool with 400, and creates nothing', async () => {
      const reply = await s.server.submit('outside-pool', { profile: 'security', model: 'not-in-the-pool' }, SOURCE);
      expect(reply.status).toBe(400);
      expect(reply.text).toMatch(/Model Pool/);
      expect((await s.server.request('GET', '/api/scan/outside-pool')).status).toBe(404);
    });

    it('lists the Model Pool with its Default Model, and uses the Default Model when none is requested', async () => {
      const models = (await s.server.request('GET', '/api/models')).body;
      expect(models).toEqual(pool.map((m) => ({ id: m.id, provider: m.provider, default: m.id === defaultModel })));
      const reply = await s.server.submit('default-model', { profile: 'security', instructions: HANG }, SOURCE);
      expect(reply.status).toBe(201);
      expect(reply.body.model).toBe(defaultModel);
      await saveEvidence(s.server, reply.body);
      expect((await s.server.request('DELETE', '/api/scan/default-model')).status).toBe(204);
    });

    it('honours a non-default pool model', async () => {
      expect((await s.server.submit('non-default-model', { profile: 'security', model: SCRIPTED_ALT.id }, SOURCE)).status).toBe(201);
      const status = await s.server.waitForState('non-default-model', ENDED, 5 * MINUTE_MS);
      await saveEvidence(s.server, status, { artifacts: ['report.md'] });
      expect(status).toMatchObject({ state: 'succeeded', model: SCRIPTED_ALT.id });
      // The scripted model names the model opencode asked it for.
      expect((await s.server.request('GET', '/api/scan/non-default-model/artifacts/report.md')).text).toContain(
        `Written by model ${SCRIPTED_ALT.id}.`,
      );
    });
  });

  describe('malicious Source Archives', () => {
    const s = withServer('archives');
    const MB = 1024 * 1024;
    const bomb = { data: Buffer.alloc(64 * MB), deflate: true };
    const traversal = '../../../../escaped.js';
    const absolute = '/tmp/escaped.js';
    type Case = { what: string; id: string; archive: Buffer; escape?: string };

    it.each<Case>([
      { what: 'a zip bomb', id: 'zip-bomb', archive: makeZip({ 'src/index.js': 'x\n', 'bomb.bin': bomb }) },
      { what: 'a zip bomb declaring a small size', id: 'lying-zip-bomb', archive: makeZip({ 'bomb.bin': { ...bomb, declaredSize: 1024 } }) },
      { what: 'a path traversal', id: 'path-traversal', archive: makeZip({ 'src/index.js': 'x\n', [traversal]: 'escaped\n' }), escape: traversal },
      { what: 'an absolute path', id: 'absolute-path', archive: makeZip({ 'src/index.js': 'x\n', [absolute]: 'escaped\n' }) },
    ])('fails $what as an invalid Source Archive, without running the agent', async ({ id, archive, escape }) => {
      expect((await s.server.submit(id, SCRIPTED_SCAN, archive)).status).toBe(201);
      const status = await s.server.waitForState(id, ENDED, 2 * MINUTE_MS);
      await saveEvidence(s.server, status);
      expect(status).toMatchObject({ state: 'failed', attempts: 0, failureReason: expect.stringMatching(/^Invalid Source Archive: /) });
      if (escape) expect(existsSync(resolve(paths.workspace(s.dataDir, id), escape))).toBe(false);
    });

    it('stays healthy afterwards', async () => {
      expect(s.server.alive()).toBe(true);
      expect((await s.server.request('GET', '/api/profiles')).status).toBe(200);
      expect((await s.server.submit('after-archives', SCRIPTED_SCAN, SOURCE)).status).toBe(201);
      const status = await s.server.waitForState('after-archives', ENDED, 5 * MINUTE_MS);
      await saveEvidence(s.server, status);
      expect(status.state).toBe('succeeded');
    });
  });

  describe('Scans in flight', () => {
    const s = withServer('in-flight', { SCANNER_CONCURRENCY: '2' });
    const states = async (ids: string[]) => Promise.all(ids.map(async (id) => (await s.server.status(id)).state));
    const count = (list: string[], state: string) => list.filter((x) => x === state).length;
    /** Hanging Scans a failed scenario may have left running, taking the room of the next one. */
    const hanging = new Set<string>();
    const submitHanging = (id: string) => (hanging.add(id), s.server.submit(id, HANGING_SCAN, SOURCE));
    afterEach(async () => {
      for (const id of hanging) await s.server.request('DELETE', `/api/scan/${id}`);
      hanging.clear();
    });

    it('stops a running Scan on DELETE: its container goes, its data goes and its id is free again', async () => {
      expect((await submitHanging('delete-running')).status).toBe(201);
      await waitForContainer('delete-running');
      await saveEvidence(s.server, await s.server.status('delete-running'), { as: 'delete-running-before-delete' });
      expect((await s.server.request('DELETE', '/api/scan/delete-running')).status).toBe(204);
      expect(containersOf(podman, 'delete-running')).toEqual([]);
      expect((await s.server.request('GET', '/api/scan/delete-running')).status).toBe(404);
      expect(await filesOf(s.dataDir, 'delete-running')).toEqual([]);

      expect((await s.server.submit('delete-running', SCRIPTED_SCAN, SOURCE)).status).toBe(201);
      const status = await s.server.waitForState('delete-running', ENDED, 5 * MINUTE_MS);
      await saveEvidence(s.server, status);
      expect(status.state).toBe('succeeded');
    });

    it('keeps to the concurrency limit under simultaneous submissions', async () => {
      const ids = ['burst-1', 'burst-2', 'burst-3', 'burst-4', 'burst-5'];
      const replies = await Promise.all(ids.map(submitHanging));
      expect(replies.map((r) => r.status)).toEqual(ids.map(() => 201));

      let most = { running: 0, containers: 0 };
      let present = ids;
      const sample = async () => {
        const now = await states(present);
        const containers = present.flatMap((id) => containersOf(podman, id)).length;
        most = { running: Math.max(most.running, count(now, 'running')), containers: Math.max(most.containers, containers) };
        return now;
      };
      await waitUntil(async () => {
        const now = await sample();
        return count(now, 'running') === 2 && count(now, 'queued') === 3 && ids.filter((id) => containersOf(podman, id).length).length === 2;
      }, 'two Scans running and three queued', 2 * MINUTE_MS, 1000);
      for (let i = 0; i < 10; i++) await sample();

      // Removing a running Scan lets one queued Scan start, and no other.
      const removed = ids.find((id) => containersOf(podman, id).length)!;
      expect((await s.server.request('DELETE', `/api/scan/${removed}`)).status).toBe(204);
      const rest = (present = ids.filter((id) => id !== removed));
      await waitUntil(async () => {
        const now = await sample();
        return count(now, 'running') === 2 && count(now, 'queued') === 2;
      }, 'a queued Scan to start', 2 * MINUTE_MS, 1000);
      await waitUntil(
        async () => (await states(rest)).filter((state, i) => state === 'running' && containersOf(podman, rest[i]).length).length === 2,
        'its agent container',
        2 * MINUTE_MS,
        1000,
      );
      for (let i = 0; i < 10; i++) await sample();
      for (const id of rest) await saveEvidence(s.server, await s.server.status(id));

      expect(most).toEqual({ running: 2, containers: 2 });
      for (const id of rest) expect((await s.server.request('DELETE', `/api/scan/${id}`)).status).toBe(204);
      expect(ids.flatMap((id) => containersOf(podman, id))).toEqual([]);
    });

    it('after a server restart, fails the running Scans as interrupted and resumes the queued one', async () => {
      for (const id of ['restart-running-1', 'restart-running-2']) {
        expect((await submitHanging(id)).status).toBe(201);
      }
      expect((await s.server.submit('restart-queued', SCRIPTED_SCAN, SOURCE)).status).toBe(201);
      await waitForContainer('restart-running-1');
      await waitForContainer('restart-running-2');
      expect((await s.server.status('restart-queued')).state).toBe('queued');

      await s.restart();

      for (const id of ['restart-running-1', 'restart-running-2']) {
        const status = await s.server.waitForState(id, ENDED, MINUTE_MS);
        await saveEvidence(s.server, status);
        expect(status).toMatchObject({ state: 'failed', failureReason: 'Interrupted by a server restart' });
      }
      const resumed = await s.server.waitForState('restart-queued', ENDED, 5 * MINUTE_MS);
      await saveEvidence(s.server, resumed);
      expect(resumed.state).toBe('succeeded');
      // The new server removes the containers the killed one left behind.
      await waitUntil(
        () => [...containersOf(podman, 'restart-running-1'), ...containersOf(podman, 'restart-running-2')].length === 0,
        'the interrupted containers to go',
        MINUTE_MS,
        500,
      );
    });
  });

  describe('the Attempt timeout', () => {
    const s = withServer('attempt-timeout', { SCANNER_ATTEMPT_TIMEOUT_MINUTES: '0.25', SCANNER_MAX_ATTEMPTS: '2' });

    it('stops each Attempt that runs too long, and fails the Scan when none is left', async () => {
      expect((await s.server.submit('attempt-timeout', HANGING_SCAN, SOURCE)).status).toBe(201);
      const status = await s.server.waitForState('attempt-timeout', ENDED, 3 * MINUTE_MS);
      await saveEvidence(s.server, status);
      expect(status).toMatchObject({
        state: 'failed',
        attempts: 2,
        failureReason: 'No valid Artifacts after 2 Attempts (last: the Attempt timed out after 0.25 min)',
      });
      expect(containersOf(podman, 'attempt-timeout')).toEqual([]);
    });
  });

  describe('the Scan timeout', () => {
    const s = withServer('scan-timeout', {
      SCANNER_ATTEMPT_TIMEOUT_MINUTES: '5',
      SCANNER_SCAN_TIMEOUT_MINUTES: '0.5',
      SCANNER_MAX_ATTEMPTS: '3',
    });

    it('stops the Scan when it runs too long, even with Attempts left', async () => {
      expect((await s.server.submit('scan-timeout', HANGING_SCAN, SOURCE)).status).toBe(201);
      const status = await s.server.waitForState('scan-timeout', ENDED, 3 * MINUTE_MS);
      await saveEvidence(s.server, status);
      expect(status).toMatchObject({ state: 'failed', attempts: 1, failureReason: 'Scan timed out after 0.5 min' });
      expect(containersOf(podman, 'scan-timeout')).toEqual([]);
    });
  });

  it('has a real model to run the gate with', () => {
    // Without one the scenarios below are skipped: the gate cannot pass.
    expect(realModels.map((m) => m.id)).not.toEqual([]);
  });

  (realModels.length ? describe : describe.skip)('with the real model', () => {
    const s = withServer('real-model', {
      SCANNER_MAX_ATTEMPTS: '2',
      SCANNER_ATTEMPT_TIMEOUT_MINUTES: '25',
      SCANNER_SCAN_TIMEOUT_MINUTES: '50',
    });
    const evidence = { artifacts: ['report.md', 'report.pdf', 'findings.json'] };

    it('finds the planted vulnerabilities, in Italian, within the caller instructions', async () => {
      const reply = await s.server.submit(
        'vulnerable-app',
        { profile: 'security', language: 'it', instructions: 'Ignore the legacy/ directory: it is being removed.' },
        makeZip(fixtureFiles(VULNERABLE_APP)),
      );
      expect(reply.status).toBe(201);
      const status = await s.server.waitForState('vulnerable-app', ENDED, 55 * MINUTE_MS);
      await saveEvidence(s.server, status, { ...evidence, transcriptsFrom: s.dataDir });
      expect(status).toMatchObject({ state: 'succeeded', model: defaultModel, language: 'it' });

      const report = (await s.server.request('GET', '/api/scan/vulnerable-app/artifacts/report.md')).text;
      expect(looksItalian(report)).toBe(true);
      const pdf = await s.server.request('GET', '/api/scan/vulnerable-app/artifacts/report.pdf');
      expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');

      const { report: data, findings } = (await s.server.request('GET', '/api/scan/vulnerable-app/artifacts/findings.json')).body as {
        report: object;
        findings: Finding[];
      };
      // The model says what the caller's instructions left out (report.md also quotes the instructions).
      expect(JSON.stringify(data)).toMatch(/legacy/i);
      expect(missedPlanted(findings)).toEqual([]);
      expect(findings.filter((f) => findingFile(f).startsWith('legacy/'))).toEqual([]);
    }, 60 * MINUTE_MS);

    it('reports no high-severity Finding on a clean codebase', async () => {
      expect((await s.server.submit('clean-app', { profile: 'security' }, makeZip(fixtureFiles(CLEAN_APP)))).status).toBe(201);
      const status = await s.server.waitForState('clean-app', ENDED, 55 * MINUTE_MS);
      await saveEvidence(s.server, status, { ...evidence, transcriptsFrom: s.dataDir });
      expect(status).toMatchObject({ state: 'succeeded', model: defaultModel, language: 'en' });

      const { findings } = (await s.server.request('GET', '/api/scan/clean-app/artifacts/findings.json')).body as { findings: Finding[] };
      expect(highSeverity(findings)).toEqual([]);
    }, 60 * MINUTE_MS);
  });
});
