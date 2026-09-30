import { createServer, request, Server } from 'node:http';
import { AddressInfo, connect } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createProxy } = require('../containers/egress-proxy/proxy.js') as { createProxy(allow: string[]): Server };

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

  beforeAll(async () => {
    const endpoint = (name: string) => createServer((_req, res) => res.end(`hello from ${name}`));
    servers.push(endpoint('model'), endpoint('elsewhere'));
    [modelPort, otherPort] = await Promise.all(servers.map(listen));
    const proxy = createProxy([`127.0.0.1:${modelPort}`]);
    servers.push(proxy);
    proxyPort = await listen(proxy);
  });
  afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

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

  it('forwards plain HTTP only to an allowed model endpoint', async () => {
    expect(await viaProxy(proxyPort, `http://127.0.0.1:${modelPort}/v1/models`)).toEqual({
      status: 200,
      body: 'hello from model',
    });
    expect((await viaProxy(proxyPort, `http://127.0.0.1:${otherPort}/`)).status).toBe(403);
  });
});
