import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesUnder, Harness, scripts, startApp, waitUntil } from './harness';
import { GitServer, makeRepo, startGitServer } from './git-server';

const GIT_TOKEN = 'sekret-saved-token-7777';
const SECRET_KEY = 'a-secret-key-for-tests-only';

describe('Saved Repositories', () => {
  jest.setTimeout(120_000);
  let root: string;
  let open: GitServer;
  let locked: GitServer;
  let h: Harness;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-scanner-saved-'));
    await makeRepo(root, 'app', {
      main: { 'src/main.js': 'console.log("main")\n' },
      dev: { 'src/main.js': 'console.log("dev")\n' },
      tag: 'v1.0.0',
    });
    open = await startGitServer(root);
    locked = await startGitServer(root, GIT_TOKEN);
  });
  afterAll(async () => {
    await open.close();
    await locked.close();
    await rm(root, { recursive: true, force: true });
  });

  let seenMain: string | undefined;
  beforeEach(async () => {
    h = await startApp({ config: { secretKey: SECRET_KEY } });
    seenMain = undefined;
    h.runner.script = async (req, ctl) => {
      seenMain = await readFile(join(req.workspaceDir, 'src', 'main.js'), 'utf8').catch(() => undefined);
      await scripts.writeReport()(req, ctl);
    };
  });
  afterEach(() => h.dispose());

  /** A private repository is the admin's: only the admin token stores a token. */
  const save = (body: Record<string, unknown>) => (body.token ? h.admin : h.api).post('/api/repositories').send(body);

  it('saves, lists, changes and removes a repository', async () => {
    const created = await save({ id: 'app', description: 'The app', url: open.url('app'), ref: 'dev' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'app', description: 'The app', url: open.url('app'), ref: 'dev', tokenSet: false, tokenHint: null });

    expect((await h.api.get('/api/repositories')).body.map((r: { id: string }) => r.id)).toEqual(['app']);
    const changed = await h.api.patch('/api/repositories/app').send({ ref: null, description: 'Main' });
    expect(changed.body).toMatchObject({ ref: null, description: 'Main' });

    expect((await h.api.delete('/api/repositories/app')).status).toBe(204);
    expect((await h.api.get('/api/repositories/app')).status).toBe(404);
  });

  it.each([
    ['a bad id', { id: 'Not OK', url: 'URL' }, /Repository id/],
    ['a file:// URL', { id: 'x', url: 'file:///etc' }, /must be http/],
    ['credentials in the URL', { id: 'x', url: 'https://user:pw@example.com/a.git' }, /credential fields/],
    ['a ref that looks like an option', { id: 'x', url: 'URL', ref: '--upload-pack=x' }, /Not a branch or tag/],
  ])('refuses %s', async (_what, body: Record<string, string>, message) => {
    const res = await save({ ...body, url: body.url === 'URL' ? open.url('app') : body.url });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  });

  it('refuses a second repository with the same id', async () => {
    await save({ id: 'app', url: open.url('app') });
    expect((await save({ id: 'app', url: open.url('app') })).status).toBe(409);
  });

  it('keeps the token sealed: never sent back, nowhere in clear on disk', async () => {
    const res = await save({ id: 'private', url: locked.url('app'), token: GIT_TOKEN });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tokenSet: true, tokenHint: GIT_TOKEN.slice(-4) });
    expect(JSON.stringify((await h.api.get('/api/repositories/private')).body)).not.toContain(GIT_TOKEN);
    for (const file of filesUnder(h.dataDir)) {
      expect({ file, leaks: (await readFile(file)).includes(GIT_TOKEN) }).toEqual({ file, leaks: false });
    }
  });

  it('refuses to store a token without SCANNER_SECRET_KEY, but saves a public repository', async () => {
    await h.dispose();
    h = await startApp();
    const res = await save({ id: 'private', url: locked.url('app'), token: GIT_TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/SCANNER_SECRET_KEY/);
    expect((await save({ id: 'public', url: open.url('app') })).status).toBe(201);
  });

  it('lists the branches and tags with the stored credentials', async () => {
    await save({ id: 'private', url: locked.url('app'), token: GIT_TOKEN });
    const res = await h.admin.post('/api/repositories/private/refs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ default: 'main', branches: ['dev', 'main'], tags: ['v1.0.0'] });
    expect(locked.seenAuth.at(-1)).toBe(`Basic ${Buffer.from(`oauth2:${GIT_TOKEN}`).toString('base64')}`);
  });

  it('removing the token makes the private repository unreadable', async () => {
    await save({ id: 'private', url: locked.url('app'), token: GIT_TOKEN });
    const res = await h.admin.patch('/api/repositories/private').send({ token: null });
    expect(res.body).toMatchObject({ tokenSet: false, tokenHint: null });
    expect((await h.api.post('/api/repositories/private/refs')).status).toBe(400);
  });

  it('sends a stored token to no other host than the one it was given for', async () => {
    await save({ id: 'private', url: locked.url('app'), token: GIT_TOKEN });
    // Another port is another host.
    const moved = await h.admin.patch('/api/repositories/private').send({ url: open.url('app') });
    expect(moved.status).toBe(400);
    expect(moved.body.message).toMatch(/needs the token again/);
    expect((await h.admin.patch('/api/repositories/private').send({ url: open.url('app'), token: null })).status).toBe(200);
  });

  it('keeps a private repository to the admin token: storing, using and managing it', async () => {
    const stored = await h.api.post('/api/repositories').send({ id: 'private', url: locked.url('app'), token: GIT_TOKEN });
    expect(stored.status).toBe(403);
    expect(stored.body.message).toMatch(/needs the admin token/);
    await save({ id: 'private', url: locked.url('app'), token: GIT_TOKEN });
    await save({ id: 'public', url: open.url('app') });
    expect((await h.api.patch('/api/repositories/public').send({ token: GIT_TOKEN })).status).toBe(403);

    // Listed to callers, without its token, but theirs to use no further: the server never fetches for them.
    const fetches = locked.seenAuth.length;
    expect((await h.api.get('/api/repositories')).body.map((r: { id: string }) => r.id)).toEqual(['private', 'public']);
    expect((await h.api.post('/api/repositories/private/refs')).status).toBe(403);
    expect((await h.api.patch('/api/repositories/private').send({ ref: 'dev' })).status).toBe(403);
    expect((await h.api.delete('/api/repositories/private')).status).toBe(403);
    const scan = await h.submit('caller-private', { profile: 'security', repository: 'private' }, null);
    expect(scan.status).toBe(403);
    expect((await h.api.get('/api/scan/caller-private')).status).toBe(404);
    expect(locked.seenAuth.length).toBe(fetches);
  });

  describe('POST /api/scan/<id> with repository', () => {
    const submit = (id: string, fields: Record<string, string>) => h.submit(id, { profile: 'security', ...fields }, null);

    it("scans the repository's ref with its stored credentials, and records where it came from", async () => {
      await save({ id: 'private', url: locked.url('app'), ref: 'dev', token: GIT_TOKEN });
      const res = await h.admin.post('/api/scan/from-saved').field('profile', 'security').field('repository', 'private');
      expect(res.status).toBe(201);
      expect(res.body.source).toEqual({
        type: 'git',
        url: locked.url('app'),
        ref: 'dev',
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        repository: 'private',
        private: true,
      });
      await waitUntil(async () => (await h.admin.get('/api/scan/from-saved')).body.state === 'succeeded', 'the private Scan');
      expect(seenMain).toBe('console.log("dev")\n');
      expect(JSON.stringify((await h.admin.get('/api/scan/from-saved')).body)).not.toContain(GIT_TOKEN);
    });

    it('keeps the Scans of a private repository to the admin token: they show its code', async () => {
      await save({ id: 'private', url: locked.url('app'), token: GIT_TOKEN });
      await h.admin.post('/api/scan/private-scan').field('profile', 'security').field('repository', 'private').expect(201);
      await save({ id: 'app', url: open.url('app') });
      await submit('public-scan', { repository: 'app' }).expect(201);
      await waitUntil(async () => (await h.admin.get('/api/scan/private-scan')).body.state === 'succeeded', 'the private Scan');

      expect((await h.api.get('/api/scans')).body.map((s: { id: string }) => s.id)).toEqual(['public-scan']);
      expect((await h.admin.get('/api/scans')).body.map((s: { id: string }) => s.id).sort()).toEqual(['private-scan', 'public-scan']);
      for (const path of ['', '/events', '/artifacts/report.md']) {
        expect({ path, status: (await h.api.get(`/api/scan/private-scan${path}`)).status }).toEqual({ path, status: 403 });
      }
      expect((await h.api.delete('/api/scan/private-scan')).status).toBe(403);
      expect((await h.admin.get('/api/scan/private-scan/artifacts/report.md')).status).toBe(200);
      expect((await h.api.get('/api/scan/public-scan')).body.source.private).toBeUndefined();
    });

    it("takes a ref over the repository's own", async () => {
      await save({ id: 'app', url: open.url('app'), ref: 'dev' });
      const res = await submit('saved-tag', { repository: 'app', ref: 'v1.0.0' });
      expect(res.body.source.ref).toBe('v1.0.0');
      await h.waitForState('saved-tag', 'succeeded');
      expect(seenMain).toBe('console.log("main")\n');
    });

    it.each([
      ['an unknown repository', { repository: 'nope' }, /Unknown repository/],
      ['a repository and a URL', { repository: 'app', repoUrl: 'URL' }, /Give one of/],
      ['credentials with a repository', { repository: 'app', gitToken: 'x' }, /stored credentials/],
    ])('refuses %s', async (_what, fields: Record<string, string>, message) => {
      await save({ id: 'app', url: open.url('app') });
      const resolved = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === 'URL' ? open.url('app') : v]));
      const res = await submit('saved-bad', resolved);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
      expect((await h.api.get('/api/scan/saved-bad')).status).toBe(404);
    });
  });

  it('needs the token like every route', async () => {
    expect((await h.anonymous().get('/api/repositories')).status).toBe(401);
  });
});
