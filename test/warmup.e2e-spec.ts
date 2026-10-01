import { readFile } from 'node:fs/promises';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { paths } from '../src/common/paths';
import { Harness, scripts, startApp, waitUntil } from './harness';

/** How the fake model answers each completion request in turn (the last repeats); `hang` never answers. */
type Answer = { status: number; body?: object | string } | 'hang';

/** An OpenAI-compatible model that records the completions it is asked for. */
class FakeModel {
  server!: Server;
  readonly requests: { path: string; auth?: string; body: any }[] = [];
  answers: Answer[] = [{ status: 200, body: { choices: [{ message: { content: 'OK' } }] } }];
  private readonly hanging: ServerResponse[] = [];

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async stop(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    this.requests.push({ path: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    const answer = this.answers[Math.min(this.requests.length - 1, this.answers.length - 1)];
    if (answer === 'hang') {
      this.hanging.push(res);
      return;
    }
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}));
  }
}

describe('Model warm-up (ADR-0009)', () => {
  let h: Harness;
  let model: FakeModel;

  beforeEach(async () => {
    model = new FakeModel();
    process.env.WARMUP_TEST_KEY = 'k-warm-123';
  });
  afterEach(async () => {
    await h?.dispose();
    await model.stop();
    delete process.env.WARMUP_TEST_KEY;
  });

  async function start(warmupTimeoutMs = 60_000) {
    const baseUrl = await model.start();
    h = await startApp({
      config: {
        models: [{ id: 'warm', provider: 'local', baseUrl, apiKeyEnv: 'WARMUP_TEST_KEY' }],
        defaultModel: 'warm',
        warmupTimeoutMs,
        warmupRetryMs: 10,
      },
    });
    h.runner.script = scripts.writeReport();
  }

  const warmupLog = async (id: string) =>
    (await readFile(paths.warmupLog(h.dataDir, id), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).text as string);

  it('asks the model for one token before the first Attempt, then runs the Scan', async () => {
    await start();
    await h.submit('s1');
    expect((await h.waitForState('s1', 'succeeded')).attempts).toBe(1);
    expect(model.requests).toHaveLength(1);
    const [req] = model.requests;
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.auth).toBe('Bearer k-warm-123');
    expect(req.body).toMatchObject({ model: 'warm', max_tokens: 1, stream: false });
    expect(h.runner.calls).toHaveLength(1);
    const log = await warmupLog('s1');
    expect(log[0]).toMatch(/^Warming up local\/warm at 127\.0\.0\.1:\d+$/);
    expect(log.at(-1)).toMatch(/^local\/warm is ready \(\d+ s\)$/);
    expect(log.join('\n')).not.toContain('k-warm-123');
  });

  it('shows the Scan as warming while the model wakes up, and starts no Attempt meanwhile', async () => {
    await start();
    model.answers = ['hang'];
    await h.submit('s1');
    await h.waitForState('s1', 'warming');
    expect(h.runner.calls).toEqual([]);
  });

  it('waits for a model that answers 503 while it scales up', async () => {
    await start();
    model.answers = [{ status: 503 }, { status: 429 }, { status: 200, body: {} }];
    await h.submit('s1');
    await h.waitForState('s1', 'succeeded');
    expect(model.requests).toHaveLength(3);
    const log = await warmupLog('s1');
    expect(log).toEqual(expect.arrayContaining([expect.stringMatching(/^Answered 503: trying again in/), expect.stringMatching(/^Answered 429: trying again in/)]));
  });

  it.each([
    [401, '{"error":"invalid api key"}', /answered 401: \{"error":"invalid api key"\}/],
    [404, '{"error":"model not found"}', /answered 404/],
  ])('fails the Scan at once, without any Attempt, when the model answers %s', async (status, body, reason) => {
    await start();
    model.answers = [{ status, body }];
    await h.submit('s1');
    const scan = await h.waitForState('s1', 'failed');
    expect(scan.failureReason).toMatch(/^Model warm is not usable: /);
    expect(scan.failureReason).toMatch(reason);
    expect(scan.attempts).toBe(0);
    expect(h.runner.calls).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });

  it('asks again with max_completion_tokens when the model refuses max_tokens', async () => {
    await start();
    model.answers = [{ status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens'" } } }, { status: 200, body: {} }];
    await h.submit('s1');
    await h.waitForState('s1', 'succeeded');
    expect(model.requests[1].body).toMatchObject({ max_completion_tokens: 1 });
    expect(model.requests[1].body.max_tokens).toBeUndefined();
  });

  it('fails the Scan when the model does not answer within the warm-up timeout', async () => {
    await start(1500);
    model.answers = ['hang'];
    await h.submit('s1');
    const scan = await h.waitForState('s1', 'failed', 10_000);
    expect(scan.failureReason).toBe('Model warm is not usable: local/warm did not answer within 0.025 min');
    expect(h.runner.calls).toEqual([]);
  });

  it('stops warming up when the Scan is deleted', async () => {
    await start();
    model.answers = ['hang'];
    await h.submit('s1');
    await h.waitForState('s1', 'warming');
    expect((await h.api.delete('/api/scan/s1')).status).toBe(204);
    expect((await h.api.get('/api/scan/s1')).status).toBe(404);
    expect(h.runner.calls).toEqual([]);
  });

  it('starts the Scan timeout only after the warm-up', async () => {
    await start();
    model.answers = ['hang'];
    await h.submit('s1');
    await h.waitForState('s1', 'warming');
    // Far beyond the Scan timeout: it is not counting yet.
    h.clock.advance(5 * 60 * 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect((await h.api.get('/api/scan/s1')).body.state).toBe('warming');
  });

  it('streams the warm-up as Attempt 0 activity', async () => {
    await start();
    model.answers = [{ status: 503 }, { status: 200, body: {} }];
    await h.submit('s1');
    await h.waitForState('s1', 'succeeded');
    const res = await h.api
      .get('/api/scan/s1/events')
      .buffer(true)
      .parse((stream, done) => {
        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (c: string) => (body += c));
        stream.on('end', () => done(null, body));
      });
    const field = (block: string, name: string) => block.split('\n').find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
    const warmup = String(res.body)
      .split('\n\n')
      .filter((b) => field(b, 'event') === 'activity')
      .map((b) => JSON.parse(field(b, 'data')!))
      .filter((a) => a.attempt === 0);
    expect(warmup.map((a) => a.kind)).toEqual(['log', 'log', 'log']);
    expect(warmup[0].text).toMatch(/^Warming up local\/warm/);
    expect(warmup[2].text).toMatch(/is ready/);
  });

  it('puts a Scan left warming by a restart back in the queue', async () => {
    await start();
    model.answers = ['hang'];
    await h.submit('s1');
    await waitUntil(() => model.requests.length === 1, 'the first warm-up request');
    await h.close();
    model.answers = [{ status: 200, body: {} }];
    h = await startApp({
      dataDir: h.dataDir,
      config: { models: [], defaultModel: 'warm', warmupTimeoutMs: 60_000, warmupRetryMs: 10 },
    });
    h.runner.script = scripts.writeReport();
    expect((await h.waitForState('s1', 'succeeded')).attempts).toBe(1);
    // Warmed up again from the start, by the new process.
    expect(model.requests).toHaveLength(2);
    expect((await warmupLog('s1')).filter((l) => l.startsWith('Warming up'))).toHaveLength(2);
  });
});
