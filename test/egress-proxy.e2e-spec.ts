import { ChildProcess, spawn } from 'node:child_process';
import { createServer, request, Server } from 'node:http';
import { AddressInfo, connect } from 'node:net';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Starts the proxy as its container does, in a process of its own; resolves with its port. */
function startProxy(allow: string[] | { file: string }): Promise<{ child: ChildProcess; port: number }> {
  const script = resolve(__dirname, '..', 'containers', 'egress-proxy', 'proxy.js');
  const source = Array.isArray(allow) ? { ALLOW: allow.join(',') } : { ALLOW_FILE: allow.file };
  const child = spawn(process.execPath, [script], { env: { ...process.env, ALLOW: '', ...source, PORT: '0' } });
  return new Promise((done, fail) => {
    child.stdout!.once('data', (line) => done({ child, port: Number(/:(\d+)/.exec(String(line))![1]) }));
    child.once('exit', (code) => fail(new Error(`proxy exited with ${code}`)));
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** Sends a CONNECT, then a GET through the tunnel when it opens. Resolves with what came back. */
function tunnel(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk;
      if (received.startsWith('HTTP/1.1 200') && received.endsWith('\r\n\r\n')) {
        socket.write(`GET / HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
      }
    });
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
  });
}

/** A plain-HTTP request through the proxy, as a client configured with HTTP_PROXY sends it. */
function viaProxy(
  proxyPort: number,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { Host: new URL(url).host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('egress proxy', () => {
  const servers: Server[] = [];
  let modelPort: number;
  let otherPort: number;
  let proxyPort: number;
  let proxy: ChildProcess;

  beforeAll(async () => {
    // `/slow` never answers, to leave a request in flight; `/headers` echoes the request headers.
    const endpoint = (name: string) =>
      createServer((req, res) => {
        if (req.url === '/headers') res.end(JSON.stringify(req.headers));
        else if (req.url !== '/slow') res.end(`hello from ${name}`);
      });
    servers.push(endpoint('model'), endpoint('elsewhere'));
    [modelPort, otherPort] = await Promise.all(servers.map(listen));
    ({ child: proxy, port: proxyPort } = await startProxy([`127.0.0.1:${modelPort}`]));
  });
  afterAll(() => {
    proxy.kill();
    return Promise.all(
      servers.map((s) => {
        s.closeAllConnections();
        return new Promise((r) => s.close(r));
      }),
    );
  });

  it('tunnels to an allowed model endpoint', async () => {
    const reply = await tunnel(proxyPort, `127.0.0.1:${modelPort}`);
    expect(reply).toMatch(/^HTTP\/1.1 200 Connection Established/);
    expect(reply).toContain('hello from model');
  });

  it('refuses to tunnel anywhere else', async () => {
    const reply = await tunnel(proxyPort, `127.0.0.1:${otherPort}`);
    expect(reply).toMatch(/^HTTP\/1.1 403/);
    expect(reply).not.toContain('hello from elsewhere');
  });

  it('survives clients that reset their connection mid-request', async () => {
    const requests = [
      `GET http://127.0.0.1:${modelPort}/slow`,
      `CONNECT 127.0.0.1:${modelPort}`,
      `CONNECT 127.0.0.1:${otherPort}`, // denied, then reset: as a client does when refused
    ];
    for (const line of requests) {
      await new Promise<void>((resolve) => {
        const socket = connect(proxyPort, '127.0.0.1', () => {
          socket.write(`${line} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
          setTimeout(() => {
            socket.resetAndDestroy();
            resolve();
          }, 50);
        });
      });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(proxy.exitCode).toBeNull();
    expect(await tunnel(proxyPort, `127.0.0.1:${modelPort}`)).toContain('hello from model');
  });

  it('keeps proxy credentials and hop-by-hop headers from the model endpoint', async () => {
    const { body } = await viaProxy(proxyPort, `http://127.0.0.1:${modelPort}/headers`, {
      'Proxy-Authorization': 'Basic c2VjcmV0',
      'Proxy-Connection': 'keep-alive',
      Authorization: 'Bearer model-key',
    });
    const received = JSON.parse(body);
    expect(received).not.toHaveProperty('proxy-authorization');
    expect(received).not.toHaveProperty('proxy-connection');
    expect(received.authorization).toBe('Bearer model-key');
  });

  it('forwards plain HTTP only to an allowed model endpoint', async () => {
    expect(await viaProxy(proxyPort, `http://127.0.0.1:${modelPort}/v1/models`)).toEqual({
      status: 200,
      body: 'hello from model',
    });
    expect((await viaProxy(proxyPort, `http://127.0.0.1:${otherPort}/`)).status).toBe(403);
  });

  describe('with an allow-list file', () => {
    let dir: string;
    let fileProxy: ChildProcess;
    let filePort: number;
    const allowFile = () => join(dir, 'allow.txt');
    /** As the server writes it: whole, then renamed into place. */
    const writeAllow = async (text: string) => {
      await writeFile(`${allowFile()}.tmp`, text);
      await rename(`${allowFile()}.tmp`, allowFile());
    };

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'ai-scanner-egress-'));
      ({ child: fileProxy, port: filePort } = await startProxy({ file: allowFile() }));
    });
    afterAll(async () => {
      fileProxy.kill();
      await rm(dir, { recursive: true, force: true });
    });

    it('follows the file as it changes, and allows nothing without it', async () => {
      // No file yet: nothing is allowed.
      expect(await tunnel(filePort, `127.0.0.1:${modelPort}`)).toMatch(/^HTTP\/1.1 403/);

      await writeAllow(`127.0.0.1:${otherPort}\n127.0.0.1:${modelPort}\n`);
      expect(await tunnel(filePort, `127.0.0.1:${modelPort}`)).toContain('hello from model');
      expect((await viaProxy(filePort, `http://127.0.0.1:${otherPort}/`)).status).toBe(200);

      await writeAllow(`127.0.0.1:${otherPort}`);
      expect(await tunnel(filePort, `127.0.0.1:${modelPort}`)).toMatch(/^HTTP\/1.1 403/);

      await writeAllow('');
      expect((await viaProxy(filePort, `http://127.0.0.1:${otherPort}/`)).status).toBe(403);

      await rm(allowFile());
      expect((await viaProxy(filePort, `http://127.0.0.1:${otherPort}/`)).status).toBe(403);
    });
  });
});
