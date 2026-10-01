import { Logger, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_ROOT } from '../common/app-root';
import { AppConfig, ModelEntry, PodmanConfig } from '../config/app-config';
import { endpointOf, isBuiltInKind, KIND_INFO } from '../models/provider-kinds';
import { agentCommand, agentEnv, agentSecrets, IN_CONTAINER } from './agent-spec';
import { AgentModel, AttemptRequest, AttemptResult, Runner } from './runner';

/** Every Attempt's proxy joins this network too, to reach its model; agents never do. */
export const EGRESS_NETWORK = 'ai-scanner-egress';
const PROXY_PORT = 3128;
/** How long an Attempt's proxy may take to listen before the Attempt fails. */
const PROXY_READY_MS = 30_000;
/** Every container and network of an Attempt carries it, with the Scan id as value. */
export const SCAN_LABEL = 'ai-scanner.scan';
/** And this one, with the server instance's id: a server cleans up only its own leftovers. */
export const INSTANCE_LABEL = 'ai-scanner.instance';

const PROXY_SCRIPT = resolve(APP_ROOT, 'containers', 'egress-proxy', 'proxy.js');

/** The `host:port` a SCANNER_MODELS entry's requests go to. */
export function modelEndpoint(model: ModelEntry): string {
  const url = model.baseUrl ?? (isBuiltInKind(model.provider) ? KIND_INFO[model.provider].defaultBaseUrl : undefined);
  if (!url) throw new Error(`Model ${model.id}: provider ${model.provider} needs a baseUrl in SCANNER_MODELS`);
  return endpointOf(url);
}

/**
 * A server instance's id: the same data directory always gives the same one. Two servers, or a
 * server and the smoke tests, on one host never touch each other's containers.
 */
export function instanceOf(dataDir: string): string {
  return createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 10);
}

interface RunningAttempt {
  container: string;
  /** The Attempt's own egress proxy, and the internal network it shares with the agent alone. */
  proxy: string;
  network: string;
  stopped: boolean;
}

/**
 * Runs each Attempt as opencode, headless, in its own ephemeral Podman container (ADR-0003).
 * The workspace is mounted read-only and /output writable; the root filesystem is read-only;
 * the container has no capabilities. Its only network is one of its own, with no route out,
 * shared with a proxy of its own that lets through its model's endpoint and nothing else.
 * All three go when the Attempt ends.
 */
export class PodmanRunner extends Runner implements OnModuleInit {
  private readonly log = new Logger(PodmanRunner.name);
  private readonly podman: PodmanConfig;
  private readonly instance: string;
  private readonly running = new Map<string, RunningAttempt>();
  private ready?: Promise<void>;

  constructor(config: AppConfig) {
    super();
    this.podman = config.podman;
    this.instance = instanceOf(config.dataDir);
  }

  async run(request: AttemptRequest): Promise<AttemptResult> {
    const name = `ais-${this.instance}-${request.scanId}-${request.attempt}`;
    const attempt: RunningAttempt = { container: name, proxy: `${name}-proxy`, network: `${name}-net`, stopped: false };
    this.running.set(request.scanId, attempt); // before any await: see Runner.stop
    try {
      await this.prepared();
      await this.exec(['network', 'create', '--internal', ...this.labels(request.scanId), attempt.network]);
      if (attempt.stopped) return { exitCode: 137 };
      await this.startProxy(attempt, request);
      if (attempt.stopped) return { exitCode: 137 };
      const model = request.agentModel;
      await this.withSecrets(model, (envFile) =>
        this.exec(['create', '--env-file', envFile, ...this.containerArgs(request, attempt, model)]),
      );
      if (attempt.stopped) return { exitCode: 137 };
      return { exitCode: await this.startAttached(attempt.container, request.transcriptPath) };
    } finally {
      if (this.running.get(request.scanId) === attempt) this.running.delete(request.scanId);
      await this.remove(attempt.container);
      await this.remove(attempt.proxy);
      await this.removeNetwork(attempt.network);
    }
  }

  /** Prepares right away, so containers a crashed process left behind stop now, not at the next Attempt. */
  onModuleInit(): void {
    this.prepared().catch((e) => this.log.error(`Could not prepare Podman: ${e.message}`));
  }

  /** Runs `prepare` once; a failed preparation is retried by the next caller. */
  private prepared(): Promise<void> {
    return (this.ready ??= this.prepare().catch((e) => {
      this.ready = undefined;
      throw e;
    }));
  }

  async stop(scanId: string): Promise<void> {
    const attempt = this.running.get(scanId);
    if (!attempt) return;
    attempt.stopped = true;
    await this.remove(attempt.container);
  }

  /** What every container and network of an Attempt carries. */
  private labels(scanId: string): string[] {
    return ['--label', `${SCAN_LABEL}=${scanId}`, '--label', `${INSTANCE_LABEL}=${this.instance}`];
  }

  /**
   * The Attempt's egress proxy, on its network and the egress network, allowing only its model's
   * endpoint, fixed for its whole life. Resolves once it listens, so the agent's first request
   * never races it.
   */
  private async startProxy(attempt: RunningAttempt, request: AttemptRequest): Promise<void> {
    await this.exec([
      'run', '--detach', '--name', attempt.proxy, ...this.labels(request.scanId),
      '--network', `${attempt.network},${EGRESS_NETWORK}`,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '64', '--memory', '128m',
      '--volume', `${PROXY_SCRIPT}:/proxy.js:ro`,
      '--env', `ALLOW=${request.modelEgress.join(',')}`,
      '--env', `PORT=${PROXY_PORT}`,
      this.podman.proxyImage, 'node', '/proxy.js',
    ]);
    for (const deadline = Date.now() + PROXY_READY_MS; ; ) {
      const logs = await this.exec(['logs', attempt.proxy]).catch(() => '');
      if (logs.includes('egress proxy on')) return;
      const state = (await this.exec(['inspect', '--format', '{{.State.Status}}', attempt.proxy]).catch(() => '')).trim();
      if (state === 'exited' || state === '') throw new Error(`The egress proxy did not start: ${logs.trim().slice(-300)}`);
      if (Date.now() > deadline) throw new Error('The egress proxy did not start listening in time');
      if (attempt.stopped) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private containerArgs(request: AttemptRequest, attempt: RunningAttempt, model: AgentModel): string[] {
    const env = agentEnv(request, model, `http://${attempt.proxy}:${PROXY_PORT}`);
    const args = [
      '--name', attempt.container,
      ...this.labels(request.scanId),
      '--network', attempt.network,
      '--read-only',
      '--tmpfs', '/tmp:rw,size=512m',
      '--tmpfs', `${IN_CONTAINER.home}:rw,size=512m`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '512',
      '--memory', this.podman.memory,
      '--user', '0:0', // rootless: the invoking user on the host, so /output stays writable
      '--volume', `${request.workspaceDir}:${IN_CONTAINER.workspace}:ro`,
      '--volume', `${request.outputDir}:${IN_CONTAINER.output}:rw`,
      '--workdir', IN_CONTAINER.workspace,
    ];
    if (request.skillsDir) args.push('--volume', `${request.skillsDir}:${IN_CONTAINER.skills}:ro`);
    for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
    args.push(this.podman.agentImage, ...this.agentCommand(request, model));
    return args;
  }

  /**
   * Hands the agent's secrets (SCANNER_AGENT_ENV, and the model's key or apiKeyEnv) to `use` as an env
   * file, removed once `use` settles: they stay off the command line, and a remote podman
   * client (Windows, macOS) would not forward `--env NAME` values from this process.
   */
  private async withSecrets<T>(model: AgentModel, use: (envFile: string) => Promise<T>): Promise<T> {
    const lines = Object.entries(agentSecrets(model, this.podman.agentEnv, (m) => this.log.warn(m))).map(([k, v]) => `${k}=${v}`);
    const dir = await mkdtemp(join(tmpdir(), 'ai-scanner-env-'));
    try {
      const file = join(dir, 'agent.env');
      await writeFile(file, lines.map((line) => `${line}\n`).join(''), { mode: 0o600 });
      return await use(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The command the agent container runs. */
  protected agentCommand(request: AttemptRequest, model: AgentModel): string[] {
    return agentCommand(request, model);
  }

  /**
   * Once per process: removes the containers and networks a previous process of this instance
   * left behind, and creates the egress network the proxies reach out through.
   */
  private async prepare(): Promise<void> {
    const mine = `label=${INSTANCE_LABEL}=${this.instance}`;
    const leftovers = await this.exec(['ps', '-aq', '--filter', mine]);
    for (const id of leftovers.split(/\s+/).filter(Boolean)) await this.remove(id);
    const networks = await this.exec(['network', 'ls', '-q', '--filter', mine]);
    for (const id of networks.split(/\s+/).filter(Boolean)) await this.removeNetwork(id);

    if (!(await this.succeeds(['network', 'exists', EGRESS_NETWORK]))) {
      await this.exec(['network', 'create', EGRESS_NETWORK]);
    }
  }

  private async remove(container: string): Promise<void> {
    await this.exec(['rm', '--force', '--time', '0', '--ignore', container]).catch((e) =>
      this.log.warn(`Could not remove container ${container}: ${e.message}`),
    );
  }

  private async removeNetwork(network: string): Promise<void> {
    await this.exec(['network', 'rm', '--force', network]).catch((e) => {
      if (!/no such network|network not found|unable to find network/i.test(e.message)) {
        this.log.warn(`Could not remove network ${network}: ${e.message}`);
      }
    });
  }

  /** Starts the container, waits for it to exit and returns its exit code; its output goes to `logPath`. */
  private startAttached(container: string, logPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const log = createWriteStream(logPath);
      const child = spawn(this.podman.executable, ['start', '--attach', container], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on('error', (e) => log.end(() => reject(e)));
      child.on('close', (code, signal) => log.end(() => resolve(code ?? (signal ? 128 : 1))));
    });
  }

  private async succeeds(args: string[]): Promise<boolean> {
    return this.exec(args).then(
      () => true,
      () => false,
    );
  }

  /** Runs podman with an argument list, never through a shell; resolves with its stdout. */
  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.podman.executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(`podman ${args[0]} exited with ${code}: ${stderr.trim()}`)),
      );
    });
  }
}
