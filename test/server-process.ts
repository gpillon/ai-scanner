/**
 * The built server (`dist/main.js`) run as a process of its own and driven over HTTP, as a
 * caller would: the system under test of the e2e gate.
 */
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { IncomingMessage, request as httpRequest } from 'node:http';
import { AddressInfo, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { waitUntil } from './harness';

const ROOT = resolve(__dirname, '..');

/** Compiles the server into dist/, so the gate never runs a stale build. */
export function buildServer(): void {
  const build = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`The server does not build:\n${build.stdout}${build.stderr}`);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer().on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

export interface Reply {
  status: number;
  contentType: string;
  bytes: Buffer;
  text: string;
  /** The parsed body, when it is JSON. */
  body: any;
}

export class ServerProcess {
  private constructor(
    private readonly child: ChildProcess,
    private readonly url: string,
    private readonly token: string,
  ) {}

  /** Starts the server with `env` over this process's environment, its output appended to `logPath`, and waits until it answers. */
  static async start(env: Record<string, string>, logPath: string): Promise<ServerProcess> {
    const port = await freePort();
    const log = createWriteStream(logPath, { flags: 'a' });
    log.write(`--- started ${new Date().toISOString()} on port ${port}\n`);
    const child = spawn(process.execPath, [join(ROOT, 'dist', 'main.js')], {
      cwd: ROOT,
      env: { ...process.env, ...env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.pipe(log);
    child.stderr!.pipe(log);
    const server = new ServerProcess(child, `http://127.0.0.1:${port}`, env.SCANNER_TOKEN);
    await waitUntil(
      async () => {
        if (!server.alive()) throw new Error(`The server exited while starting: see ${logPath}`);
        return server.request('GET', '/api/openapi.json').then(
          (r) => r.status === 200,
          () => false,
        );
      },
      'the server to answer',
      60_000,
      500,
    );
    return server;
  }

  alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Ends the process at once, as a crash would: nothing of the server's shutdown runs. */
  async kill(): Promise<void> {
    if (!this.alive()) return;
    const exited = once(this.child, 'exit');
    this.child.kill('SIGKILL');
    await exited;
  }

  /**
   * Sends the bearer token unless `token` says otherwise: `null` for none. Each request opens its
   * own connection: a kept-alive one may be reset as the server closes it for idling.
   */
  async request(method: string, path: string, options: { token?: string | null; form?: FormData } = {}): Promise<Reply> {
    const token = options.token === undefined ? this.token : options.token;
    const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` };
    let payload: Buffer | undefined;
    if (options.form) {
      const encoded = new Response(options.form);
      payload = Buffer.from(await encoded.arrayBuffer());
      headers['content-type'] = encoded.headers.get('content-type')!;
      headers['content-length'] = String(payload.length);
    }
    const res = await new Promise<IncomingMessage>((done, fail) =>
      httpRequest(this.url + path, { method, headers, agent: false }, done).on('error', fail).end(payload),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const contentType = res.headers['content-type'] ?? '';
    const text = bytes.toString('utf8');
    return { status: res.statusCode!, contentType, bytes, text, body: contentType.includes('json') ? JSON.parse(text) : undefined };
  }

  submit(id: string, fields: Record<string, string>, archive: Buffer): Promise<Reply> {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append('file', new Blob([new Uint8Array(archive)], { type: 'application/zip' }), 'source.zip');
    return this.request('POST', `/api/scan/${id}`, { form });
  }

  async status(id: string): Promise<any> {
    const reply = await this.request('GET', `/api/scan/${id}`);
    if (reply.status !== 200) throw new Error(`GET /api/scan/${id} answered ${reply.status}: ${reply.text}`);
    return reply.body;
  }

  async waitForState(id: string, states: string | string[], timeoutMs: number): Promise<any> {
    const wanted = Array.isArray(states) ? states : [states];
    let last: any;
    try {
      await waitUntil(async () => wanted.includes((last = await this.status(id)).state), `Scan ${id} to be ${wanted.join('|')}`, timeoutMs, 1000);
    } catch (e) {
      throw new Error(`${(e as Error).message}; last status: ${JSON.stringify(last)}`);
    }
    return last;
  }
}
