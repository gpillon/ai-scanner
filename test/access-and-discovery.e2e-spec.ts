import { Harness, startApp } from './harness';

describe('access and discovery', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startApp();
  });
  afterEach(() => h.dispose());

  describe('bearer token', () => {
    it.each([
      ['GET', '/api/profiles'],
      ['GET', '/api/models'],
      ['GET', '/api/scans'],
      ['GET', '/api/me'],
      ['GET', '/api/scan/abc'],
      ['GET', '/api/scan/abc/artifacts/report.md'],
      ['GET', '/api/scan/abc/events'],
      ['POST', '/api/scan/abc'],
      ['DELETE', '/api/scan/abc'],
    ])('%s %s without a token gives 401', async (method, url) => {
      const res = await h.anonymous()[method.toLowerCase() as 'get'](url);
      expect(res.status).toBe(401);
    });

    it('a wrong token gives 401', async () => {
      const res = await h.anonymous().get('/api/models').set('Authorization', 'Bearer nope');
      expect(res.status).toBe(401);
    });

    it('a token without the Bearer scheme gives 401', async () => {
      const res = await h.anonymous().get('/api/models').set('Authorization', 'test-token');
      expect(res.status).toBe(401);
    });
  });

  it('lists Scan Profiles with description and whether they produce Findings', async () => {
    const res = await h.api.get('/api/profiles');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: 'security', description: expect.any(String), producesFindings: true },
    ]);
  });

  it('lists the Model Pool with the Default Model marked', async () => {
    const res = await h.api.get('/api/models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 'fast-model', provider: 'openai-compatible', default: true },
      { id: 'deep-model', provider: 'anthropic', default: false },
    ]);
  });

  it('serves the OpenAPI description covering every endpoint', async () => {
    const res = await h.anonymous().get('/api/openapi.json');
    expect(res.status).toBe(200);
    const operations = Object.entries(res.body.paths).flatMap(([path, item]) =>
      Object.keys(item as object).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.sort()).toEqual(
      [
        'GET /api/scans',
        'GET /api/me',
        'POST /api/scan/{id}',
        'GET /api/scan/{id}',
        'DELETE /api/scan/{id}',
        'GET /api/scan/{id}/artifacts/{name}',
        'GET /api/scan/{id}/events',
        'GET /api/profiles',
        'GET /api/models',
      ].sort(),
    );
  });
});
