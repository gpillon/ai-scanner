'use strict';
// Egress proxy for agent containers (ADR-0003). Agent containers sit on an internal network
// with no route out; this proxy is their only way out, and it lets through only the
// configured model endpoints. It runs in its own container, attached to both networks.
//
// ALLOW_FILE: a file of `host:port` pairs (comma- or newline-separated), read again for every
// connection, so the server changes the allow list at runtime; missing or unreadable, nothing
// is allowed. Without ALLOW_FILE, ALLOW holds the pairs, fixed. PORT: where to listen (3128).
// Plain JavaScript on purpose: it runs as-is on a stock Node image, mounted read-only.

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

/** `host:port` of an authority or URL, with the scheme's default port. */
function endpoint(host, port, protocol) {
  const p = port || (protocol === 'http:' ? '80' : '443');
  return `${host.toLowerCase().replace(/^\[|\]$/g, '')}:${p}`;
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/** Request headers meant for the endpoint: without those addressed to this proxy or this hop. */
function forwarded(headers) {
  const named = String(headers.connection || '').split(',').map((h) => h.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !name.startsWith('proxy-') && !HOP_BY_HOP.includes(name) && !named.includes(name)),
  );
}

/** `host:port` pairs from a comma- or newline-separated list, normalised for lookups. */
function parseAllowList(text) {
  return new Set(
    String(text || '')
      .split(/[,\n]/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Reads the allow list from `path` each time it is called; anything unreadable allows nothing. */
function allowFile(path) {
  return () => {
    try {
      return parseAllowList(fs.readFileSync(path, 'utf8'));
    } catch {
      return new Set();
    }
  };
}

/** `allow`: a list of `host:port` pairs, or a function returning the current ones. */
function createProxy(allow) {
  const fixed = typeof allow === 'function' ? undefined : parseAllowList(allow.join(','));
  const isAllowed = (target) => (fixed ?? allow()).has(target);

  const server = http.createServer((req, res) => {
    // Plain HTTP arrives as an absolute URI: only for `http://` model endpoints.
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end('absolute URI required\n');
      return;
    }
    if (target.protocol !== 'http:' || !isAllowed(endpoint(target.hostname, target.port, target.protocol))) {
      res.writeHead(403).end('egress denied\n');
      return;
    }
    const upstream = http.request(
      { host: target.hostname, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers: forwarded(req.headers) },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.on('error', () => res.destroy());
        up.pipe(res);
      },
    );
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end('upstream error\n')));
    req.on('error', () => upstream.destroy());
    res.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connect', (req, socket, head) => {
    // The socket is ours from here on, errors included: one left unhandled would end the proxy.
    socket.on('error', () => socket.destroy());
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url);
    if (!match || !isAllowed(endpoint(match[1], match[2]))) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(Number(match[2]), match[1].replace(/^\[|\]$/g, ''), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.on('clientError', (_e, socket) => socket.destroy());
  return server;
}

module.exports = { createProxy, allowFile };

if (require.main === module) {
  const file = process.env.ALLOW_FILE;
  const allow = file ? allowFile(file) : (process.env.ALLOW || '').split(',').map((e) => e.trim()).filter(Boolean);
  const server = createProxy(allow);
  server.listen(Number(process.env.PORT || 3128), () =>
    console.log(
      `egress proxy on :${server.address().port}, allowing ${file ? `what ${file} lists` : allow.join(', ') || 'nothing'}`,
    ),
  );
}
