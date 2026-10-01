import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/common/paths';
import { filesUnder, Harness, scripts, startApp } from './harness';
import { GitServer, makeRepo, startGitServer } from './git-server';

const TOKEN = 'sekret-git-token-4242';

describe('Scans from a Git repository', () => {
  jest.setTimeout(120_000);
  let root: string;
  let open: GitServer;
  let locked: GitServer;
  let h: Harness;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-scanner-repos-'));
    await makeRepo(root, 'app', {
      main: { 'src/main.js': 'console.log("main")\n', 'README.md': '# app\n' },
      dev: { 'src/main.js': 'console.log("dev")\n' },
      tag: 'v1.0.0',
      symlink: { path: 'escape', target: '/etc/passwd' },
    });
    open = await startGitServer(root);
    locked = await startGitServer(root, TOKEN);
  });
  afterAll(async () => {
    await open.close();
    await locked.close();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    h = await startApp();
  });
  afterEach(() => h.dispose());

  const submitRepo = (id: string, fields: Record<string, string>) => h.submit(id, { profile: 'security', ...fields }, null);

  /** The workspace as the agent saw it: the server removes it once the Scan ends. */
  let seen: { files: string[]; main?: string; escape?: { isFile: boolean; content: string } };
  beforeEach(() => {
    seen = { files: [] };
    h.runner.script = async (req) => {
      seen.files = await readdir(req.workspaceDir);
      seen.main = await readFile(join(req.workspaceDir, 'src', 'main.js'), 'utf8').catch(() => undefined);
      const escape = join(req.workspaceDir, 'escape');
      seen.escape = await lstat(escape).then(
        async (i) => ({ isFile: i.isFile(), content: await readFile(escape, 'utf8') }),
        () => undefined,
      );
      await scripts.writeReport()(req, { stopped: new Promise(() => undefined) });
    };
  });

  describe('POST /api/git/refs', () => {
    it('lists branches and tags, with the default branch', async () => {
      const res = await h.api.post('/api/git/refs').send({ url: open.url('app') });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ default: 'main', branches: ['dev', 'main'], tags: ['v1.0.0'] });
    });

    it('sends the credentials of a private repository, and refuses without them', async () => {
      expect((await h.api.post('/api/git/refs').send({ url: locked.url('app') })).status).toBe(400);
      const res = await h.api.post('/api/git/refs').send({ url: locked.url('app'), token: TOKEN });
      expect(res.status).toBe(200);
      expect(locked.seenAuth.at(-1)).toBe(`Basic ${Buffer.from(`oauth2:${TOKEN}`).toString('base64')}`);
    });

    it('needs the token like every route', async () => {
      expect((await h.anonymous().post('/api/git/refs').send({ url: open.url('app') })).status).toBe(401);
    });
  });

  describe('POST /api/scan/<id> with repoUrl', () => {
    it('scans the default branch, and records URL, ref and commit', async () => {
      const res = await submitRepo('git-default', { repoUrl: open.url('app') });
      expect(res.status).toBe(201);
      expect(res.body.source).toEqual({ type: 'git', url: open.url('app'), ref: null, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
      await h.waitForState('git-default', 'succeeded');
      expect(seen.main).toBe('console.log("main")\n');
      expect(seen.files).not.toContain('.git');
      // The Report names the repository and commit instead of an archive hash.
      const report = (await h.download('git-default', 'report.md')).body.toString();
      expect(report).toContain('Git repository');
      expect(report).toContain(res.body.source.commit);
    });

    it.each([
      ['a branch', 'dev', 'console.log("dev")\n'],
      ['a tag', 'v1.0.0', 'console.log("main")\n'],
    ])('scans %s', async (_what, ref, expected) => {
      const res = await submitRepo('git-ref', { repoUrl: open.url('app'), ref });
      expect(res.status).toBe(201);
      expect(res.body.source.ref).toBe(ref);
      await h.waitForState('git-ref', 'succeeded');
      expect(seen.main).toBe(expected);
    });

    it('turns a symlink of the repository into a plain file holding its target', async () => {
      await submitRepo('git-link', { repoUrl: open.url('app') });
      await h.waitForState('git-link', 'succeeded');
      expect(seen.escape).toEqual({ isFile: true, content: '/etc/passwd' });
    });

    it('keeps the credentials of a private repository nowhere', async () => {
      const res = await submitRepo('git-private', { repoUrl: locked.url('app'), gitToken: TOKEN });
      expect(res.status).toBe(201);
      await h.waitForState('git-private', 'succeeded');
      const status = await h.api.get('/api/scan/git-private');
      expect(JSON.stringify(status.body)).not.toContain(TOKEN);
      for (const file of filesUnder(h.dataDir)) {
        expect({ file, leaks: (await readFile(file)).includes(TOKEN) }).toEqual({ file, leaks: false });
      }
    });

    it('refuses a private repository without credentials, and keeps no Scan', async () => {
      const res = await submitRepo('git-denied', { repoUrl: locked.url('app') });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/refused access/);
      expect((await h.api.get('/api/scan/git-denied')).status).toBe(404);
      expect(await readdir(paths.incoming(h.dataDir))).toEqual([]);
    });

    it.each([
      ['a file:// URL', { repoUrl: 'file:///etc' }, /must be http/],
      ['an ext:: URL', { repoUrl: 'ext::sh -c touch% /tmp/pwned' }, /Not a URL|must be http/],
      ['credentials in the URL', { repoUrl: 'https://user:pw@example.com/a.git' }, /credential fields/],
      ['a ref that looks like an option', { repoUrl: 'URL', ref: '--upload-pack=touch /tmp/pwned' }, /Not a branch or tag/],
      ['an unknown ref', { repoUrl: 'URL', ref: 'nope' }, /Cannot read the repository/],
      ['both a zip and a URL', { repoUrl: 'URL', zip: '1' }, /not both/],
      ['a ref without a URL', { ref: 'main', zip: '1' }, /go with repoUrl only/],
    ])('refuses %s', async (_what, fields: Record<string, string>, message) => {
      const { zip, ...rest } = fields;
      const resolved = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === 'URL' ? open.url('app') : v]));
      const req = h.submit('git-bad', { profile: 'security', ...resolved }, zip ? undefined : null);
      const res = await req;
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(503);
      expect(res.body.message).toMatch(message);
      expect((await h.api.get('/api/scan/git-bad')).status).toBe(404);
    });

    it('refuses loopback hosts unless allowed', async () => {
      await h.dispose();
      h = await startApp({ config: { git: { timeoutMs: 60_000, hosts: [], allowHttp: true, allowLoopback: false } } });
      const res = await submitRepo('git-loop', { repoUrl: open.url('app') });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/local address/);
    });

    it('keeps to SCANNER_GIT_HOSTS when set', async () => {
      await h.dispose();
      h = await startApp({ config: { git: { timeoutMs: 60_000, hosts: ['*.example.com'], allowHttp: true, allowLoopback: true } } });
      const res = await submitRepo('git-host', { repoUrl: open.url('app') });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not allowed \(SCANNER_GIT_HOSTS\)/);
    });

    it('removes the checkout with the Scan', async () => {
      await submitRepo('git-gone', { repoUrl: open.url('app') });
      await h.waitForState('git-gone', 'succeeded');
      await h.api.delete('/api/scan/git-gone');
      expect(filesUnder(h.dataDir).some((f) => f.includes('git-gone'))).toBe(false);
    });
  });
});
