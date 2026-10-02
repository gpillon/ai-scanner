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
import { agentCommand, agentEnv, agentSecrets, IN_CONTAINER, PREPARATION_COMMAND, preparationEnv, variantImageOrThrow } from './agent-spec';
import { AgentImageUnavailableError, AgentModel, AttemptRequest, AttemptResult, PreparationRequest, Runner } from './runner';

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
  scanId: string;
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
 * All three go when the Attempt ends. A Scan's Preparation runs the same way, with its script
 * for command, /prepared writable, and a proxy letting through its profile's endpoints only
 * (ADR-0015).
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
    const model = request.agentModel;
    const image = variantImageOrThrow(this.podman.agentImage, request.imageVariant);
    return this.launch(
      { scanId: request.scanId, name: `ais-${this.instance}-${request.scanId}-${request.attempt}`, allow: request.modelEgress, image },
      request.transcriptPath,
      () => agentSecrets(model, this.podman.agentEnv, (m) => this.log.warn(m)),
      (attempt) => this.containerArgs(request, attempt, model, image),
    );
  }

  async runPreparation(request: PreparationRequest): Promise<AttemptResult> {
    const image = variantImageOrThrow(this.podman.agentImage, request.imageVariant);
    return this.launch(
      { scanId: request.scanId, name: `ais-${this.instance}-${request.scanId}-prep`, allow: request.egress, image },
      request.logPath,
      () => ({}),
      (attempt) => this.preparationArgs(request, attempt, image),
    );
  }

  /**
   * Runs one container of `image` on a network of its own, behind a proxy of its own that lets
   * through `allow` only, and removes all three once it exits; its output goes to `logPath`. Its
   * `secrets` reach it through an env file.
   */
  private async launch(
    job: { scanId: string; name: string; allow: string[]; image: string },
    logPath: string,
    secrets: () => Record<string, string>,
    args: (attempt: RunningAttempt) => string[],
  ): Promise<AttemptResult> {
    const { scanId, name } = job;
    const attempt: RunningAttempt = { scanId, container: name, proxy: `${name}-proxy`, network: `${name}-net`, stopped: false };
    this.running.set(scanId, attempt); // before any await: see Runner.stop
    try {
      await this.prepared();
      await this.ensureImage(job.image);
      if (attempt.stopped) return { exitCode: 137 };
      await this.exec(['network', 'create', '--internal', ...this.labels(scanId), attempt.network]);
      if (attempt.stopped) return { exitCode: 137 };
      await this.startProxy(attempt, job.allow);
      if (attempt.stopped) return { exitCode: 137 };
      await this.withEnvFile(secrets(), (envFile) => this.exec(['create', '--env-file', envFile, ...args(attempt)]));
      if (attempt.stopped) return { exitCode: 137 };
      return { exitCode: await this.startAttached(attempt.container, logPath) };
    } finally {
      if (this.running.get(scanId) === attempt) this.running.delete(scanId);
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
   * The Attempt's egress proxy, on its network and the egress network, allowing only `allow`
   * (its model's endpoint, and its profile's), fixed for its whole life. Resolves once it
   * listens, so the agent's first request never races it.
   */
  private async startProxy(attempt: RunningAttempt, allow: string[]): Promise<void> {
    await this.exec([
      'run', '--detach', '--name', attempt.proxy, ...this.labels(attempt.scanId),
      '--network', `${attempt.network},${EGRESS_NETWORK}`,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '64', '--memory', '128m',
      '--volume', `${PROXY_SCRIPT}:/proxy.js:ro`,
      '--env', `ALLOW=${allow.join(',')}`,
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

  /** What the agent's and the Preparation's containers share: the isolation, and the workspace read-only. */
  private isolationArgs(attempt: RunningAttempt, workspaceDir: string): string[] {
    return [
      '--name', attempt.container,
      ...this.labels(attempt.scanId),
      '--network', attempt.network,
      '--read-only',
      '--tmpfs', '/tmp:rw,size=512m',
      '--tmpfs', `${IN_CONTAINER.home}:rw,size=512m`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '512',
      '--memory', this.podman.memory,
      '--user', '0:0', // rootless: the invoking user on the host, so /output stays writable
      '--volume', `${workspaceDir}:${IN_CONTAINER.workspace}:ro`,
    ];
  }

  private containerArgs(request: AttemptRequest, attempt: RunningAttempt, model: AgentModel, image: string): string[] {
    const env = agentEnv(request, model, `http://${attempt.proxy}:${PROXY_PORT}`);
    const args = [
      ...this.isolationArgs(attempt, request.workspaceDir),
      '--volume', `${request.outputDir}:${IN_CONTAINER.output}:rw`,
      '--workdir', IN_CONTAINER.workspace,
    ];
    if (request.skillsDir) args.push('--volume', `${request.skillsDir}:${IN_CONTAINER.skills}:ro`);
    if (request.preparedDir) args.push('--volume', `${request.preparedDir}:${IN_CONTAINER.prepared}:ro`);
    for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
    args.push(image, ...this.agentCommand(request, model));
    return args;
  }

  /** The Preparation's container: the agent image running the profile's script, with /prepared writable. */
  private preparationArgs(request: PreparationRequest, attempt: RunningAttempt, image: string): string[] {
    const args = [
      ...this.isolationArgs(attempt, request.workspaceDir),
      '--volume', `${request.preparedDir}:${IN_CONTAINER.prepared}:rw`,
      '--volume', `${request.scriptDir}:${IN_CONTAINER.prepare}:ro`,
      '--workdir', IN_CONTAINER.prepared,
    ];
    const env = preparationEnv(`http://${attempt.proxy}:${PROXY_PORT}`);
    for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
    args.push(image, ...PREPARATION_COMMAND);
    return args;
  }

  /**
   * Hands secrets (the agent's: SCANNER_AGENT_ENV, and the model's key or apiKeyEnv) to `use` as
   * an env file, removed once `use` settles: they stay off the command line, and a remote podman
   * client (Windows, macOS) would not forward `--env NAME` values from this process.
   */
  private async withEnvFile<T>(secrets: Record<string, string>, use: (envFile: string) => Promise<T>): Promise<T> {
    const lines = Object.entries(secrets).map(([k, v]) => `${k}=${v}`);
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

  /** Pulls the image unless the host has it: one that cannot be had fails the Scan, not just this Attempt. */
  private async ensureImage(image: string): Promise<void> {
    if (await this.succeeds(['image', 'exists', image])) return;
    await this.exec(['pull', image]).catch((e) => {
      throw new AgentImageUnavailableError(image, (e as Error).message);
    });
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
