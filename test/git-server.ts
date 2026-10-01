/**
 * A Git server for the tests: `git http-backend` run as CGI behind Node's HTTP server, with an
 * optional Basic-auth check. It serves the bare repositories under a directory, smart protocol
 * included, so shallow fetches work as against a real forge.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface GitServer {
  /** `http://127.0.0.1:<port>/<name>.git` */
  url(name: string): string;
  /** The Authorization headers it received. */
  readonly seenAuth: (string | undefined)[];
  close(): Promise<void>;
}

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/**
 * A bare repository `<root>/<name>.git` with a commit per entry of `commits` on `main`, branch
 * `dev` and tag `v1` as described.
 */
export async function makeRepo(
  root: string,
  name: string,
  spec: { main: Record<string, string>; dev?: Record<string, string>; tag?: string; symlink?: { path: string; target: string } },
): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'ai-scanner-repo-'));
  try {
    git(work, 'init', '--quiet');
    const write = async (files: Record<string, string>) => {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(work, path)), { recursive: true });
        await writeFile(join(work, path), content);
      }
      git(work, 'add', '-A');
    };
    await write(spec.main);
    if (spec.symlink) {
      // A symlink as Git stores it (mode 120000), whatever the platform can create.
      const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: work, input: spec.symlink.target, encoding: 'utf8' }).stdout.trim();
      git(work, 'update-index', '--add', '--cacheinfo', `120000,${blob},${spec.symlink.path}`);
    }
    git(work, 'commit', '--quiet', '-m', 'main');
    if (spec.tag) git(work, 'tag', spec.tag);
    if (spec.dev) {
      git(work, 'checkout', '--quiet', '-b', 'dev');
      await write(spec.dev);
      git(work, 'commit', '--quiet', '-m', 'dev');
      git(work, 'checkout', '--quiet', 'main');
    }
    git(root, 'clone', '--quiet', '--bare', work, `${name}.git`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Serves `root` over HTTP; with `token`, only to requests carrying it as a Basic-auth password. */
export async function startGitServer(root: string, token?: string): Promise<GitServer> {
  const seenAuth: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (token) {
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const password = basic ? Buffer.from(basic, 'base64').toString().split(':').slice(1).join(':') : undefined;
      if (password !== token) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' }).end();
        return;
      }
    }
    cgi(root, req).then(
      ({ status, headers, body }) => {
        res.writeHead(status, headers);
        res.end(body);
      },
      () => res.writeHead(500).end(),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (name) => `http://127.0.0.1:${port}/${name}.git`,
    seenAuth,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function cgi(root: string, req: IncomingMessage): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = new URL(req.url ?? '/', 'http://x');
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      ...(req.headers['content-encoding'] && { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) }),
      ...(req.headers['git-protocol'] && { GIT_PROTOCOL: String(req.headers['git-protocol']) }),
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(child.stdin);
  const chunks: Buffer[] = [];
  child.stdout.on('data', (c) => chunks.push(c));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => {
      const all = Buffer.concat(chunks);
      const end = all.indexOf('\r\n\r\n');
      const head = all.subarray(0, end).toString();
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.split('\r\n')) {
        const [k, ...v] = line.split(':');
        if (k.toLowerCase() === 'status') status = parseInt(v.join(':'), 10);
        else if (k) headers[k] = v.join(':').trim();
      }
      resolve({ status, headers, body: all.subarray(end + 4) });
    });
  });
}
