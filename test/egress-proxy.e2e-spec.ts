import { ChildProcess, spawn } from 'node:child_process';
import { createServer, request, Server } from 'node:http';
import { AddressInfo, connect } from 'node:net';
import { resolve } from 'node:path';

/** Starts the proxy as its container does, in a process of its own; resolves with its port. */
function startProxy(allow: string[]): Promise<{ child: ChildProcess; port: number }> {
  const script = resolve(__dirname, '..', 'containers', 'egress-proxy', 'proxy.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ALLOW: allow.join(','), PORT: '0' } });
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
function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { Host: new URL(url).host } }, (res) => {
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
    // `/slow` never answers, to leave a request in flight.
    const endpoint = (name: string) =>
      createServer((req, res) => void (req.url === '/slow' || res.end(`hello from ${name}`)));
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

  it('forwards plain HTTP only to an allowed model endpoint', async () => {
    expect(await viaProxy(proxyPort, `http://127.0.0.1:${modelPort}/v1/models`)).toEqual({
      status: 200,
      body: 'hello from model',
    });
    expect((await viaProxy(proxyPort, `http://127.0.0.1:${otherPort}/`)).status).toBe(403);
  });
});
