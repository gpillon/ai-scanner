import { loadConfig } from '../src/config/app-config';
import { ADMIN_TOKEN, Harness, startApp, TOKEN } from './harness';

describe('admin token', () => {
  let h: Harness;
  afterEach(() => h?.dispose());

  it('GET /api/me tells the shared token from the admin one', async () => {
    h = await startApp();
    expect((await h.api.get('/api/me')).body).toEqual({ role: 'caller' });
    expect((await h.admin.get('/api/me')).body).toEqual({ role: 'admin' });
    expect((await h.anonymous().get('/api/me')).status).toBe(401);
  });

  it('opens the Scan API too', async () => {
    h = await startApp();
    expect((await h.admin.get('/api/scans')).status).toBe(200);
    expect((await h.admin.get('/api/models')).status).toBe(200);
  });

  it('is not accepted when none is configured', async () => {
    h = await startApp({ config: { adminToken: undefined } });
    expect((await h.admin.get('/api/me')).status).toBe(401);
    expect((await h.api.get('/api/me')).body).toEqual({ role: 'caller' });
  });

  it('must differ from the shared token', () => {
    const env = { SCANNER_TOKEN: TOKEN, SCANNER_MODELS: '[{"id":"m","provider":"anthropic"}]' };
    expect(loadConfig({ ...env, SCANNER_ADMIN_TOKEN: ADMIN_TOKEN }).adminToken).toBe(ADMIN_TOKEN);
    expect(loadConfig(env).adminToken).toBeUndefined();
    expect(() => loadConfig({ ...env, SCANNER_ADMIN_TOKEN: TOKEN })).toThrow(/must differ/);
  });
});
