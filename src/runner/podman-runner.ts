import { Logger, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_ROOT } from '../common/app-root';
import { paths } from '../common/paths';
import { AppConfig, ModelEntry, PodmanConfig } from '../config/app-config';
import { endpointOf, isBuiltInKind, KIND_INFO } from '../models/provider-kinds';
import { agentCommand, agentEnv, agentSecrets, AllowList, IN_CONTAINER } from './agent-spec';
import { AgentModel, AttemptRequest, AttemptResult, Runner } from './runner';

/** Agent containers join only this network: it has no route out of the host. */
const AGENT_NETWORK = 'ai-scanner-agents';
/** The egress proxy joins this one too, to reach the model endpoints. */
export const EGRESS_NETWORK = 'ai-scanner-egress';
const PROXY_CONTAINER = 'ai-scanner-egress-proxy';
const PROXY_PORT = 3128;
/** Every agent container carries it, with the Scan id as value. */
export const SCAN_LABEL = 'ai-scanner.scan';

const PROXY_SCRIPT = resolve(APP_ROOT, 'containers', 'egress-proxy', 'proxy.js');

/** The `host:port` a SCANNER_MODELS entry's requests go to. */
export function modelEndpoint(model: ModelEntry): string {
  const url = model.baseUrl ?? (isBuiltInKind(model.provider) ? KIND_INFO[model.provider].defaultBaseUrl : undefined);
  if (!url) throw new Error(`Model ${model.id}: provider ${model.provider} needs a baseUrl in SCANNER_MODELS`);
  return endpointOf(url);
}

interface RunningAttempt {
  container: string;
  stopped: boolean;
}

/**
 * Runs each Attempt as opencode, headless, in its own ephemeral Podman container (ADR-0003).
 * The workspace is mounted read-only and /output writable; the root filesystem is read-only;
 * the container has no capabilities and reaches the network only through the egress proxy,
 * which lets through the Model Pool's endpoints and nothing else.
 */
export class PodmanRunner extends Runner implements OnModuleInit {
  private readonly log = new Logger(PodmanRunner.name);
  private readonly podman: PodmanConfig;
  /** Host directory holding the proxy's allow list. */
  private readonly egressDir: string;
  private readonly allowList: AllowList;
  private readonly running = new Map<string, RunningAttempt>();
  private ready?: Promise<void>;

  constructor(config: AppConfig) {
    super();
    this.podman = config.podman;
    this.egressDir = paths.egress(config.dataDir);
    this.allowList = new AllowList(this.egressDir, (m) => this.log.log(m));
  }

  async run(request: AttemptRequest): Promise<AttemptResult> {
    const attempt: RunningAttempt = { container: `ai-scanner-${request.scanId}-${request.attempt}`, stopped: false };
    this.running.set(request.scanId, attempt); // before any await: see Runner.stop
    try {
      await this.prepared();
      // The proxy reads it for every connection: an Attempt sees the Model Pool as it is now.
      await this.allowList.write(request.egress);
      const model = request.agentModel;
      await this.withSecrets(model, (envFile) =>
        this.exec(['create', '--env-file', envFile, ...this.containerArgs(request, attempt.container, model)]),
      );
      if (attempt.stopped) return { exitCode: 137 };
      return { exitCode: await this.startAttached(attempt.container, request.transcriptPath) };
    } finally {
      if (this.running.get(request.scanId) === attempt) this.running.delete(request.scanId);
      await this.remove(attempt.container);
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

  private containerArgs(request: AttemptRequest, name: string, model: AgentModel): string[] {
    const proxy = `http://${PROXY_CONTAINER}:${PROXY_PORT}`;
    const env = agentEnv(request, model, proxy);
    const args = [
      '--name', name,
      '--label', `${SCAN_LABEL}=${request.scanId}`,
      '--network', AGENT_NETWORK,
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
   * Once per process: removes agent containers a previous process left behind, and (re)creates
   * the networks and the egress proxy. Its allow list is a file each Attempt rewrites.
   */
  private async prepare(): Promise<void> {
    const leftovers = await this.exec(['ps', '-aq', '--filter', `label=${SCAN_LABEL}`]);
    for (const id of leftovers.split(/\s+/).filter(Boolean)) await this.remove(id);

    if (!(await this.succeeds(['network', 'exists', AGENT_NETWORK]))) {
      await this.exec(['network', 'create', '--internal', AGENT_NETWORK]);
    }
    if (!(await this.succeeds(['network', 'exists', EGRESS_NETWORK]))) {
      await this.exec(['network', 'create', EGRESS_NETWORK]);
    }
    await mkdir(this.egressDir, { recursive: true });
    await this.remove(PROXY_CONTAINER);
    await this.exec([
      'run', '--detach', '--restart', 'always', '--name', PROXY_CONTAINER,
      '--network', `${EGRESS_NETWORK},${AGENT_NETWORK}`,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--volume', `${PROXY_SCRIPT}:/proxy.js:ro`,
      // The directory, not the file: the allow list is replaced by renaming, which a file mount would not see.
      '--volume', `${this.egressDir}:/egress:ro`,
      '--env', 'ALLOW_FILE=/egress/allow.txt',
      '--env', `PORT=${PROXY_PORT}`,
      this.podman.proxyImage, 'node', '/proxy.js',
    ]);
  }

  private async remove(container: string): Promise<void> {
    await this.exec(['rm', '--force', '--time', '0', '--ignore', container]).catch((e) =>
      this.log.warn(`Could not remove container ${container}: ${e.message}`),
    );
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
