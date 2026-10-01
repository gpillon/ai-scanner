import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScanSchedules } from '../src/schedules/scan-schedules.service';
import { FakeClock, Gate, Harness, settle, startApp, waitUntil } from './harness';
import { GitServer, makeRepo, startGitServer } from './git-server';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

describe('Scan Schedules', () => {
  jest.setTimeout(120_000);
  let root: string;
  let git: GitServer;
  let h: Harness;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-scanner-sched-'));
    await makeRepo(root, 'app', { main: { 'src/main.js': 'console.log("main")\n' } });
    git = await startGitServer(root);
  });
  afterAll(async () => {
    await git.close();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    // The FakeClock starts at 2026-01-01T00:00:00Z.
    h = await startApp();
    await h.api.post('/api/repositories').send({ id: 'app', url: git.url('app') }).expect(201);
    await h.api.post('/api/repositories').send({ id: 'gone', url: git.url('missing') }).expect(201);
  });
  afterEach(() => h.dispose());

  const scheduler = () => h.app.get(ScanSchedules);
  const nightly = (extra: Record<string, unknown> = {}) =>
    h.api.post('/api/schedules').send({ id: 'nightly', repository: 'app', profile: 'security', cadence: 'daily', time: '02:00', ...extra });
  const schedule = async (id = 'nightly') => (await h.api.get(`/api/schedules/${id}`)).body;
  const scanIds = async () => (await h.api.get('/api/scans')).body.map((s: { id: string }) => s.id).sort();

  it('saves a schedule with its next run, and changes and removes it', async () => {
    const res = await nightly({ timeZone: 'Europe/Rome' });
    expect(res.status).toBe(201);
    // 02:00 in Rome is 01:00 UTC in winter.
    expect(res.body).toMatchObject({ id: 'nightly', enabled: true, nextRunAt: '2026-01-01T01:00:00.000Z', lastScanId: null, skillPacks: [] });

    const disabled = await h.api.patch('/api/schedules/nightly').send({ enabled: false });
    expect(disabled.body).toMatchObject({ enabled: false, nextRunAt: null });
    const weekly = await h.api.patch('/api/schedules/nightly').send({ enabled: true, cadence: 'weekly', weekdays: [1], timeZone: 'UTC' });
    // 2026-01-05 is the first Monday.
    expect(weekly.body.nextRunAt).toBe('2026-01-05T02:00:00.000Z');

    expect((await h.api.get('/api/schedules')).body.map((s: { id: string }) => s.id)).toEqual(['nightly']);
    expect((await h.api.delete('/api/schedules/nightly')).status).toBe(204);
    expect((await h.api.get('/api/schedules/nightly')).status).toBe(404);
  });

  it('keeps the next run when an edit leaves the timing as it was', async () => {
    await h.api.post('/api/schedules').send({ id: 'hourly', repository: 'app', profile: 'security', cadence: 'interval', intervalHours: 24 }).expect(201);
    h.clock.advance(HOUR_MS);
    // As the edit form sends it: every field, the timing unchanged.
    const res = await h.api
      .patch('/api/schedules/hourly')
      .send({ description: 'Daily enough', cadence: 'interval', intervalHours: 24, enabled: true, profile: 'security' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ description: 'Daily enough', nextRunAt: '2026-01-02T00:00:00.000Z' });
    const changed = await h.api.patch('/api/schedules/hourly').send({ intervalHours: 12 });
    expect(changed.body.nextRunAt).toBe('2026-01-01T13:00:00.000Z');
  });

  it.each([
    ['a bad id', { id: 'Nightly!' }, /Scan Schedule id/],
    ['an id too long for its Scan ids', { id: 'x'.repeat(49) }, /Scan Schedule id/],
    ['an unknown repository', { repository: 'nope' }, /Unknown repository/],
    ['an unknown profile', { profile: 'nope' }, /Unknown Scan Profile/],
    ['a model outside the pool', { model: 'nope' }, /not in the Model Pool/],
    ['an unknown Skill Pack', { skillPacks: ['nope'] }, /Unknown Skill Pack/],
    ['a bad time', { time: '25:00' }, /HH:MM/],
    ['an unknown time zone', { timeZone: 'Mars/Olympus' }, /Unknown time zone/],
  ])('refuses %s', async (_what, extra, message) => {
    const res = await nightly(extra);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toMatch(message);
  });

  it('starts a Scan of the repository when due, and moves on to the next run', async () => {
    await nightly();
    await scheduler().tick();
    expect(await scanIds()).toEqual([]);

    await settle();
    h.clock.advance(2 * HOUR_MS);
    await waitUntil(async () => (await scanIds()).length === 1, 'the scheduled Scan');
    const [id] = await scanIds();
    expect(id).toBe('nightly-20260101-020000');
    const scan = await h.waitForState(id, 'succeeded');
    expect(scan.source).toMatchObject({ type: 'git', url: git.url('app'), repository: 'app', schedule: 'nightly' });
    expect(await schedule()).toMatchObject({ lastScanId: id, lastError: null, nextRunAt: '2026-01-02T02:00:00.000Z' });
  });

  it('can switch off a schedule whose model left the pool, and checks it again when switched on', async () => {
    await nightly({ model: 'deep-model' });
    await h.admin.patch('/api/admin/models/deep-model').send({ enabled: false }).expect(200);
    expect((await h.api.patch('/api/schedules/nightly').send({ enabled: false })).status).toBe(200);
    const res = await h.api.patch('/api/schedules/nightly').send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not in the Model Pool/);
  });

  it('starts nothing while disabled', async () => {
    await nightly({ enabled: false });
    h.clock.advance(3 * DAY_MS);
    await scheduler().tick();
    expect(await scanIds()).toEqual([]);
  });

  it('skips a run while its previous Scan has not finished', async () => {
    const gate = new Gate();
    h.runner.script = gate.script();
    await nightly();
    h.clock.advance(2 * HOUR_MS);
    await scheduler().tick();
    const first = 'nightly-20260101-020000';
    await h.waitForState(first, 'running');

    h.clock.advance(DAY_MS);
    await scheduler().tick();
    expect(await scanIds()).toEqual([first]);
    expect((await schedule()).lastError).toMatch(/previous Scan nightly-20260101-020000 has not finished/);

    gate.release(first);
    await h.waitForState(first, 'succeeded');
    h.clock.advance(DAY_MS);
    await scheduler().tick();
    expect(await scanIds()).toEqual([first, 'nightly-20260103-020000']);
  });

  it('records why a run started no Scan, and tries again next time', async () => {
    await h.api.post('/api/schedules').send({ id: 'broken', repository: 'gone', profile: 'security', cadence: 'interval', intervalHours: 1 }).expect(201);
    h.clock.advance(HOUR_MS);
    await scheduler().tick();
    const failed = await schedule('broken');
    expect(failed.lastError).toMatch(/Cannot read the repository/);
    expect(failed.nextRunAt).toBe('2026-01-01T02:00:00.000Z');

    // Fixed: the repository now points at one that exists.
    await h.api.patch('/api/repositories/gone').send({ url: git.url('app') }).expect(200);
    h.clock.advance(HOUR_MS);
    await scheduler().tick();
    expect(await schedule('broken')).toMatchObject({ lastError: null, lastScanId: 'broken-20260101-020000' });
  });

  it('starts one Scan for the runs it missed while the server was down', async () => {
    await nightly();
    await h.close();
    const clock = new FakeClock(new Date('2026-01-04T12:00:00Z'));
    h = await startApp({ dataDir: h.dataDir, clock });
    await scheduler().tick();
    expect(await scanIds()).toEqual(['nightly-20260104-120000']);
    expect((await schedule()).nextRunAt).toBe('2026-01-05T02:00:00.000Z');
  });

  it('starts a Scan now on request, without moving the next run', async () => {
    await nightly();
    const res = await h.api.post('/api/schedules/nightly/run');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'nightly-20260101-000000', state: 'queued' });
    expect(await schedule()).toMatchObject({ lastScanId: 'nightly-20260101-000000', nextRunAt: '2026-01-01T02:00:00.000Z' });
  });

  it('keeps the schedules of a private repository to the admin token, and runs them with its token', async () => {
    await h.dispose();
    const gitToken = 'sekret-schedule-token-1234';
    const locked = await startGitServer(root, gitToken);
    try {
      h = await startApp({ config: { secretKey: 'a-secret-key-for-tests-only' } });
      await h.admin.post('/api/repositories').send({ id: 'private', url: locked.url('app'), token: gitToken }).expect(201);
      const body = { id: 'private-nightly', repository: 'private', profile: 'security', cadence: 'daily', time: '02:00' };

      const refused = await h.api.post('/api/schedules').send(body);
      expect(refused.status).toBe(403);
      expect(refused.body.message).toMatch(/needs the admin token/);
      await h.admin.post('/api/schedules').send(body).expect(201);
      expect((await h.api.patch('/api/schedules/private-nightly').send({ enabled: false })).status).toBe(403);
      expect((await h.api.post('/api/schedules/private-nightly/run')).status).toBe(403);
      expect((await h.api.delete('/api/schedules/private-nightly')).status).toBe(403);

      // The server runs it with the stored token, whoever looks at it.
      h.clock.advance(2 * HOUR_MS);
      await scheduler().tick();
      expect((await h.admin.get('/api/schedules/private-nightly')).body).toMatchObject({ lastError: null, lastScanId: 'private-nightly-20260101-020000' });
      // Its Scans show private code: the caller token does not read them.
      expect((await h.api.get('/api/scan/private-nightly-20260101-020000')).status).toBe(403);
      expect(locked.seenAuth.at(-1)).toBe(`Basic ${Buffer.from(`oauth2:${gitToken}`).toString('base64')}`);
    } finally {
      await locked.close();
    }
  });

  it('keeps a repository that a schedule uses', async () => {
    await nightly();
    const res = await h.api.delete('/api/repositories/app');
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/nightly/);
  });
});
