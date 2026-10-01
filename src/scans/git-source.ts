import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

/** How the server may reach Git repositories (ADR-0010). */
export interface GitPolicy {
  /** Kills a fetch or ls-remote that takes longer. */
  timeoutMs: number;
  /** Hostnames allowed, `*.example.com` for subdomains; empty allows any host. */
  hosts: string[];
  /** Also allow `http://`, never with credentials. */
  allowHttp: boolean;
  /** Allow loopback hosts: for tests only, never in production. */
  allowLoopback: boolean;
}

export interface GitCredentials {
  /** Defaults to `oauth2`, which GitHub and GitLab both accept with a token. */
  username?: string;
  /** A token or password. */
  token?: string;
}

export interface GitRefs {
  /** The branch HEAD points to, when the server says. */
  default: string | null;
  branches: string[];
  tags: string[];
}

/** What the caller got wrong: a 400. */
export class GitSourceError extends Error {}
/** The repository could not be read: a 502, or a 400 when the credentials are refused. */
export class GitFetchError extends Error {
  constructor(
    message: string,
    readonly authFailed: boolean,
  ) {
    super(message);
  }
}

const MAX_OUTPUT = 2 * 1024 * 1024;
const REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)[^\s~^:?*[\\\x00-\x1f\x7f]{1,200}$/;

/** Checks a ref name the caller gave: a branch or a tag, never an option. */
export function checkRef(ref: string): string {
  if (!REF_PATTERN.test(ref) || ref.endsWith('.lock') || ref === '@') throw new GitSourceError(`Not a branch or tag name: ${ref}`);
  return ref;
}

/** The URL the caller gave, checked: http(s) only, no credentials in it, host allowed. */
export async function checkRepoUrl(raw: string, policy: GitPolicy, withCredentials: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GitSourceError(`Not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp)) {
    throw new GitSourceError(policy.allowHttp ? 'The repository URL must be http(s)' : 'The repository URL must be https');
  }
  // In clear only to this machine (loopback, allowed for tests only): it never crosses a network.
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(url.hostname);
  if (url.protocol === 'http:' && withCredentials && !loopback) throw new GitSourceError('Credentials are only sent over https');
  if (url.username || url.password) throw new GitSourceError('Put credentials in the credential fields, not in the URL');
  if (url.hash) throw new GitSourceError('The repository URL cannot have a #fragment');

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (policy.hosts.length && !policy.hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h.toLowerCase()))) {
    throw new GitSourceError(`Repositories on ${host} are not allowed (SCANNER_GIT_HOSTS)`);
  }
  if (!policy.allowLoopback) {
    // Best effort against requests to the server's own machine or cloud metadata: git resolves again.
    let addresses: string[];
    try {
      addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new GitSourceError(`Cannot resolve ${host}`);
    }
    if (addresses.some(isForbiddenAddress)) throw new GitSourceError(`Repositories on ${host} are not allowed: it is a local address`);
  }
  return url;
}

/** Loopback, link-local (cloud metadata lives there) and unspecified addresses. */
function isForbiddenAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number);
    return x === 127 || x === 0 || (x === 169 && y === 254);
  }
  return a === '::1' || a === '::' || /^fe[89ab]/.test(a);
}

/**
 * Runs git with nothing of the server's own Git setup: no credential helper (it could hold the
 * server owner's logins), no system or user config, no prompts, https (or http) only, no
 * hooks, no templates. Credentials travel as an HTTP header set through the environment, so
 * they are on no command line and in no file.
 */
function runGit(args: string[], cwd: string, home: string, policy: GitPolicy, credentials?: GitCredentials): Promise<string> {
  const header = credentials?.token
    ? `Authorization: Basic ${Buffer.from(`${credentials.username || 'oauth2'}:${credentials.token}`).toString('base64')}`
    : undefined;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(process.platform === 'win32' && { SYSTEMROOT: process.env.SYSTEMROOT, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT }),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_ALLOW_PROTOCOL: policy.allowHttp ? 'http:https' : 'https',
    GIT_LFS_SKIP_SMUDGE: '1',
    ...(header && { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: header }),
  };
  const hardening = [
    '-c', 'credential.helper=',
    '-c', 'core.symlinks=false',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'submodule.recurse=false',
    '-c', 'http.lowSpeedLimit=1000',
    '-c', 'http.lowSpeedTime=30',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...hardening, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c;
      if (out.length > MAX_OUTPUT) child.kill('SIGKILL');
    });
    child.stderr.on('data', (c) => (err = (err + c).slice(-8000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), policy.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new GitFetchError(`Cannot run git: ${e.message}`, false));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      if (signal) return reject(new GitFetchError(`git took longer than ${Math.round(policy.timeoutMs / 1000)} s, or answered too much`, false));
      const message = err.trim().split('\n').filter((l) => !/^hint:/.test(l)).slice(-3).join(' ') || `git exited with ${code}`;
      const authFailed = /authentication failed|could not read username|terminal prompts disabled|401|403/i.test(err);
      reject(new GitFetchError(message, authFailed));
    });
  });
}

/** A scratch HOME with an empty Git config, removed after `use`. */
async function withHome<T>(dir: string, use: (home: string) => Promise<T>): Promise<T> {
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, '.gitconfig'), '');
  try {
    return await use(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** The branches and tags of a repository, and its default branch. */
export async function listRefs(url: URL, credentials: GitCredentials | undefined, policy: GitPolicy, workDir: string): Promise<GitRefs> {
  await mkdir(workDir, { recursive: true });
  try {
    const out = await withHome(workDir, (home) =>
      runGit(['ls-remote', '--symref', '--', url.href, 'HEAD', 'refs/heads/*', 'refs/tags/*'], workDir, home, policy, credentials),
    );
    const refs: GitRefs = { default: null, branches: [], tags: [] };
    for (const line of out.split('\n')) {
      const symref = /^ref: refs\/heads\/(\S+)\s+HEAD$/.exec(line);
      if (symref) refs.default = symref[1];
      const ref = /^[0-9a-f]{40,64}\s+refs\/(heads|tags)\/(\S+)$/.exec(line);
      if (!ref || ref[2].endsWith('^{}')) continue;
      (ref[1] === 'heads' ? refs.branches : refs.tags).push(ref[2]);
    }
    refs.branches.sort();
    refs.tags.sort().reverse();
    return refs;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export interface FetchedSource {
  /** The commit checked out. */
  commit: string;
  files: number;
  bytes: number;
}

/**
 * Checks out `ref` (the default branch when absent), one commit deep, into `target`, which must
 * not exist; `.git` is removed afterwards. Symlinks arrive as plain files holding their target.
 * The tree must hold at most `limits` files and bytes, regular files only.
 */
export async function fetchSource(
  url: URL,
  ref: string | undefined,
  credentials: GitCredentials | undefined,
  policy: GitPolicy,
  target: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<FetchedSource> {
  await mkdir(target, { recursive: true });
  const scratch = `${target}.git-home`;
  try {
    const commit = await withHome(scratch, async (home) => {
      await runGit(['init', '--quiet', '--template=', '.'], target, home, policy);
      await runGit(['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', '--', url.href, ref ?? 'HEAD'], target, home, policy, credentials);
      await runGit(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], target, home, policy);
      return (await runGit(['rev-parse', 'HEAD'], target, home, policy)).trim();
    });
    await rm(join(target, '.git'), { recursive: true, force: true });
    const { files, bytes } = await measure(target, limits);
    return { commit, files, bytes };
  } catch (e) {
    await rm(target, { recursive: true, force: true });
    throw e;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function measure(dir: string, limits: { maxFiles: number; maxBytes: number }, acc = { files: 0, bytes: 0 }): Promise<{ files: number; bytes: number }> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const info = await lstat(path);
    if (info.isDirectory()) await measure(path, limits, acc);
    else if (info.isFile()) {
      acc.files++;
      acc.bytes += info.size;
    } else throw new GitSourceError(`The repository holds ${entry.name}, neither a file nor a directory`);
    if (acc.files > limits.maxFiles) throw new GitSourceError(`The repository has more than ${limits.maxFiles} files`);
    if (acc.bytes > limits.maxBytes) throw new GitSourceError(`The repository is larger than ${limits.maxBytes} bytes`);
  }
  return acc;
}
