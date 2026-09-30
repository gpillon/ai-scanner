import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, startApp } from './harness';

describe('web UI', () => {
  let h: Harness;
  let uiDir: string;

  beforeEach(async () => {
    uiDir = await mkdtemp(join(tmpdir(), 'ai-scanner-ui-'));
    await mkdir(join(uiDir, 'assets'));
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>ai-scanner</title>');
    await writeFile(join(uiDir, 'assets', 'app.js'), 'console.log(1)');
  });
  afterEach(async () => {
    await h?.dispose();
    await rm(uiDir, { recursive: true, force: true });
  });

  it('is served under /ui/ without the token', async () => {
    h = await startApp({ config: { uiDir } });
    const page = await h.anonymous().get('/ui/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<title>ai-scanner</title>');
    expect((await h.anonymous().get('/ui/assets/app.js')).status).toBe(200);
  });

  it('makes browsers recheck index.html but keep hashed assets', async () => {
    h = await startApp({ config: { uiDir } });
    expect((await h.anonymous().get('/ui/')).headers['cache-control']).toBe('no-cache');
    expect((await h.anonymous().get('/ui/assets/app.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('is where / redirects', async () => {
    h = await startApp({ config: { uiDir } });
    const res = await h.anonymous().get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/ui/');
  });

  it('leaves the API behind the token', async () => {
    h = await startApp({ config: { uiDir } });
    expect((await h.anonymous().get('/api/models')).status).toBe(401);
    expect((await h.api.get('/api/models')).status).toBe(200);
  });

  it('is not served when the UI was not built', async () => {
    h = await startApp({ config: { uiDir: join(uiDir, 'missing') } });
    expect((await h.anonymous().get('/ui/')).status).not.toBe(200);
    expect((await h.api.get('/api/models')).status).toBe(200);
  });
});
