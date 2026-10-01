import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { paths } from '../src/common/paths';
import { Gate, Harness, scripts, startApp } from './harness';

const SECRET = 'a-secret-of-sixteen-chars-or-more';

/** A Provider API on localhost: answers `GET <prefix>/models` with `body`, and records what it was sent. */
async function fakeProvider(body: unknown, status = 200): Promise<{ url: string; seen: IncomingHttpHeaders[]; close(): Promise<void> }> {
  const seen: IncomingHttpHeaders[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.headers);
    if (!req.url?.endsWith('/models') && !req.url?.includes('/models?')) return void res.writeHead(404).end();
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe('Model Pool administration', () => {
  let h: Harness;
  afterEach(() => h?.dispose());

  describe('access', () => {
    it('needs the admin token', async () => {
      h = await startApp();
      expect((await h.api.get('/api/admin/providers')).status).toBe(403);
      expect((await h.admin.get('/api/admin/providers')).status).toBe(200);
    });

    it('is disabled without an admin token', async () => {
      h = await startApp({ config: { adminToken: undefined } });
      const res = await h.api.get('/api/admin/models');
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/SCANNER_ADMIN_TOKEN/);
    });
  });

  describe('seeding from SCANNER_MODELS', () => {
    it('imports it as Providers and models on the first start', async () => {
      h = await startApp();
      expect((await h.admin.get('/api/admin/providers')).body.map((p: any) => [p.id, p.kind])).toEqual([
        ['anthropic', 'anthropic'],
        ['openai-compatible', 'openai-compatible'],
      ]);
      expect((await h.admin.get('/api/admin/models')).body).toEqual([
        { id: 'fast-model', provider: 'openai-compatible', name: 'fast-model', enabled: true, default: true },
        { id: 'deep-model', provider: 'anthropic', name: 'deep-model', enabled: true, default: false },
      ]);
    });

    it('happens once: what the admin removed does not come back after a restart', async () => {
      h = await startApp();
      for (const id of ['deep-model', 'fast-model']) expect((await h.admin.delete(`/api/admin/models/${id}`)).status).toBe(204);
      await h.close();
      h = await startApp({ dataDir: h.dataDir });
      expect((await h.api.get('/api/models')).body).toEqual([]);
    });
  });

  describe('Providers', () => {
    it('are validated', async () => {
      h = await startApp();
      const post = (body: object) => h.admin.post('/api/admin/providers').send(body);
      expect((await post({ id: 'Bad Id', kind: 'openai' })).status).toBe(400);
      expect((await post({ id: 'x', kind: 'nope' })).status).toBe(400);
      expect((await post({ id: 'local', kind: 'openai-compatible' })).body.message).toMatch(/needs a baseUrl/);
      expect((await post({ id: 'openai', kind: 'openai-compatible', baseUrl: 'http://h/v1' })).status).toBe(400);
      expect((await post({ id: 'local', kind: 'openai-compatible', baseUrl: 'ftp://h' })).status).toBe(400);
      expect((await post({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://h:8000/v1/' })).body).toMatchObject({
        id: 'local',
        baseUrl: 'http://h:8000/v1',
        apiKeySet: false,
      });
      expect((await post({ id: 'local', kind: 'openai', baseUrl: 'http://h/v1' })).status).toBe(409);
    });

    it('keep their API key encrypted, and never give it back', async () => {
      h = await startApp({ config: { secretKey: SECRET } });
      const created = await h.admin.post('/api/admin/providers').send({ id: 'work', kind: 'anthropic', apiKey: 'sk-ant-1234567890-abcd' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ apiKeySet: true, apiKeyHint: 'abcd', effectiveBaseUrl: 'https://api.anthropic.com/v1' });
      expect(JSON.stringify(created.body)).not.toContain('sk-ant');
      const db = new Database(paths.database(h.dataDir), { readonly: true });
      const row = db.prepare('select * from providers where id = ?').get('work');
      db.close();
      expect(JSON.stringify(row)).not.toContain('sk-ant-1234567890');

      const cleared = await h.admin.patch('/api/admin/providers/work').send({ apiKey: null });
      expect(cleared.body).toMatchObject({ apiKeySet: false, apiKeyHint: null });
    });

    it('cannot store a key without SCANNER_SECRET_KEY', async () => {
      h = await startApp();
      const res = await h.admin.post('/api/admin/providers').send({ id: 'work', kind: 'anthropic', apiKey: 'sk-ant-xyz' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/SCANNER_SECRET_KEY/);
    });

    it('cannot be removed while models use them', async () => {
      h = await startApp();
      expect((await h.admin.delete('/api/admin/providers/anthropic')).status).toBe(409);
      expect((await h.admin.delete('/api/admin/models/deep-model')).status).toBe(204);
      expect((await h.admin.delete('/api/admin/providers/anthropic')).status).toBe(204);
    });
  });

  describe('discovery', () => {
    it("lists an OpenAI-compatible Provider's models, marking those already in the pool", async () => {
      const api = await fakeProvider({ data: [{ id: 'qwen-b' }, { id: 'qwen-a' }] });
      try {
        h = await startApp({ config: { secretKey: SECRET } });
        await h.admin.post('/api/admin/providers').send({ id: 'local', kind: 'openai-compatible', baseUrl: `${api.url}/v1`, apiKey: 'local-key-123456' });
        await h.admin.post('/api/admin/models').send({ provider: 'local', name: 'qwen-a', id: 'qwen' });
        const res = await h.admin.get('/api/admin/providers/local/models');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ name: 'qwen-a', inPool: 'qwen' }, { name: 'qwen-b' }]);
        expect(api.seen.at(-1)!.authorization).toBe('Bearer local-key-123456');
      } finally {
        await api.close();
      }
    });

    it('speaks the Anthropic API to Anthropic Providers', async () => {
      const api = await fakeProvider({ data: [{ id: 'claude-x', display_name: 'Claude X' }] });
      try {
        h = await startApp({ config: { secretKey: SECRET } });
        await h.admin.post('/api/admin/providers').send({ id: 'work', kind: 'anthropic', baseUrl: `${api.url}/v1`, apiKey: 'sk-ant-abcdefgh' });
        expect((await h.admin.get('/api/admin/providers/work/models')).body).toEqual([{ name: 'claude-x', displayName: 'Claude X' }]);
        expect(api.seen.at(-1)).toMatchObject({ 'x-api-key': 'sk-ant-abcdefgh', 'anthropic-version': '2023-06-01' });
      } finally {
        await api.close();
      }
    });

    it('is a 502 when the Provider refuses', async () => {
      const api = await fakeProvider({ error: 'bad key' }, 401);
      try {
        h = await startApp();
        await h.admin.post('/api/admin/providers').send({ id: 'local', kind: 'openai-compatible', baseUrl: `${api.url}/v1` });
        const res = await h.admin.get('/api/admin/providers/local/models');
        expect(res.status).toBe(502);
        expect(res.body.message).toMatch(/401/);
      } finally {
        await api.close();
      }
    });
  });

  describe('models', () => {
    it('offers only enabled ones to callers, and moves the Default Model', async () => {
      h = await startApp();
      expect((await h.admin.patch('/api/admin/models/deep-model').send({ default: true })).body).toMatchObject({ default: true });
      expect((await h.api.get('/api/models')).body).toEqual([
        { id: 'fast-model', provider: 'openai-compatible', default: false },
        { id: 'deep-model', provider: 'anthropic', default: true },
      ]);
      await h.admin.patch('/api/admin/models/fast-model').send({ enabled: false });
      expect((await h.api.get('/api/models')).body.map((m: any) => m.id)).toEqual(['deep-model']);
      expect((await h.submit('s1', { profile: 'security', model: 'fast-model' })).status).toBe(400);
      expect((await h.admin.get('/api/admin/models')).body).toHaveLength(2);
    });

    it('keep a Default Model: it cannot be disabled or removed while others remain', async () => {
      h = await startApp();
      expect((await h.admin.patch('/api/admin/models/fast-model').send({ enabled: false })).status).toBe(409);
      expect((await h.admin.patch('/api/admin/models/fast-model').send({ default: false })).status).toBe(409);
      expect((await h.admin.delete('/api/admin/models/fast-model')).status).toBe(409);
      await h.admin.patch('/api/admin/models/deep-model').send({ default: true });
      expect((await h.admin.patch('/api/admin/models/fast-model').send({ enabled: false })).status).toBe(200);
      expect((await h.submit('s1')).body.model).toBe('deep-model');
    });

    it('cannot be removed while a Scan that uses it is running', async () => {
      h = await startApp();
      const gate = new Gate();
      h.runner.script = gate.script();
      await h.submit('busy', { profile: 'security', model: 'deep-model' });
      await h.waitForState('busy', 'running');
      expect((await h.admin.delete('/api/admin/models/deep-model')).status).toBe(409);
      gate.release('busy');
      await h.waitForState('busy', 'succeeded');
      expect((await h.admin.delete('/api/admin/models/deep-model')).status).toBe(204);
    });

    it('reach the agent with their Provider, key and the allow list', async () => {
      const api = await fakeProvider({ data: [] });
      try {
        h = await startApp({ config: { secretKey: SECRET } });
        await h.admin.post('/api/admin/providers').send({ id: 'local', kind: 'openai-compatible', baseUrl: `${api.url}/v1`, apiKey: 'local-key-123456' });
        expect((await h.admin.post('/api/admin/models').send({ provider: 'local', name: 'qwen3', id: 'qwen' })).status).toBe(201);
        await h.submit('s1', { profile: 'security', model: 'qwen' });
        await h.waitForState('s1', 'succeeded');
        const [call] = h.runner.calls;
        expect(call.agentModel).toEqual({ provider: 'local', builtIn: false, name: 'qwen3', baseUrl: `${api.url}/v1`, apiKey: 'local-key-123456' });
        expect(call.egress).toEqual(expect.arrayContaining([new URL(api.url).host, 'api.anthropic.com:443']));
        // Its own proxy lets through its model's endpoint alone.
        expect(call.modelEgress).toEqual([new URL(api.url).host]);
      } finally {
        await api.close();
      }
    });

    it("fall back to the kind's usual key variable when no key is stored", async () => {
      h = await startApp();
      await h.admin.post('/api/admin/providers').send({ id: 'work', kind: 'anthropic' });
      await h.admin.post('/api/admin/models').send({ provider: 'work', name: 'claude-x' });
      await h.submit('s1', { profile: 'security', model: 'claude-x' });
      await h.waitForState('s1', 'succeeded');
      expect(h.runner.calls[0].agentModel).toEqual({ provider: 'anthropic', builtIn: true, name: 'claude-x', apiKeyEnv: 'ANTHROPIC_API_KEY' });
    });

    it('fail the Scan clearly when the stored key cannot be decrypted', async () => {
      h = await startApp({ config: { secretKey: SECRET } });
      await h.admin.post('/api/admin/providers').send({ id: 'work', kind: 'anthropic', apiKey: 'sk-ant-abcdefgh' });
      await h.admin.post('/api/admin/models').send({ provider: 'work', name: 'claude-x' });
      await h.close();
      h = await startApp({ dataDir: h.dataDir, config: { secretKey: 'another-secret-of-16-chars' } });
      h.runner.script = scripts.writeReport();
      await h.submit('s1', { profile: 'security', model: 'claude-x' });
      const status = await h.waitForState('s1', 'failed');
      expect(status.failureReason).toMatch(/cannot be decrypted/);
      expect(h.runner.calls).toHaveLength(0);
    });
  });
});
