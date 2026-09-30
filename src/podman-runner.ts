import { Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppConfig, ModelEntry, PodmanConfig } from './config';
import { AttemptRequest, AttemptResult, Runner } from './runner';

/** Agent containers join only this network: it has no route out of the host. */
export const AGENT_NETWORK = 'ai-scanner-agents';
/** The egress proxy joins this one too, to reach the model endpoints. */
export const EGRESS_NETWORK = 'ai-scanner-egress';
export const PROXY_CONTAINER = 'ai-scanner-egress-proxy';
const PROXY_PORT = 3128;
/** Every agent container carries it, with the Scan id as value. */
export const SCAN_LABEL = 'ai-scanner.scan';

const PROXY_SCRIPT = resolve(__dirname, '..', 'containers', 'egress-proxy', 'proxy.js');

/** Where providers without a `baseUrl` in the Model Pool send their requests. */
const PROVIDER_ENDPOINTS: Record<string, string> = {
  anthropic: 'api.anthropic.com:443',
  openai: 'api.openai.com:443',
  google: 'generativelanguage.googleapis.com:443',
  mistral: 'api.mistral.ai:443',
  groq: 'api.groq.com:443',
  deepseek: 'api.deepseek.com:443',
  xai: 'api.x.ai:443',
  openrouter: 'openrouter.ai:443',
};

/** The `host:port` a Model Pool entry's requests go to. */
export function modelEndpoint(model: ModelEntry): string {
  if (model.baseUrl) {
    const url = new URL(model.baseUrl);
    return `${url.hostname}:${url.port || (url.protocol === 'http:' ? 80 : 443)}`;
  }
  const known = PROVIDER_ENDPOINTS[model.provider];
  if (!known) throw new Error(`Model ${model.id}: provider ${model.provider} needs a baseUrl in SCANNER_MODELS`);
  return known;
}

/** Paths inside the agent container. */
const IN_CONTAINER = {
  workspace: '/workspace',
  output: '/output',
  config: '/etc/ai-scanner/opencode.json',
  home: '/home/agent',
  skills: '/home/agent/.config/opencode/skills',
};

/**
 * The opencode configuration of an Attempt: the chosen model, and tools limited to reading the
 * workspace and writing to /output. No shell, no web access.
 */
export function opencodeConfig(model: ModelEntry): object {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: `${model.provider}/${model.id}`,
    ...(model.baseUrl && {
      provider: {
        [model.provider]: {
          ...(PROVIDER_ENDPOINTS[model.provider] ? {} : { npm: '@ai-sdk/openai-compatible' }),
          options: { baseURL: model.baseUrl },
          models: { [model.id]: {} },
        },
      },
    }),
    autoupdate: false,
    share: 'disabled',
    permission: {
      bash: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      edit: { '*': 'deny', [`${IN_CONTAINER.output}/**`]: 'allow' },
      external_directory: { '*': 'deny', [`${IN_CONTAINER.output}/**`]: 'allow' },
    },
  };
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
export class PodmanRunner extends Runner {
  private readonly log = new Logger(PodmanRunner.name);
  private readonly podman: PodmanConfig;
  private readonly models: Map<string, ModelEntry>;
  private readonly egress: string[];
  private readonly running = new Map<string, RunningAttempt>();
  private ready?: Promise<void>;

  constructor(config: AppConfig) {
    super();
    this.podman = config.podman;
    this.models = new Map(config.models.map((m) => [m.id, m]));
    this.egress = [...new Set([...config.models.map(modelEndpoint), ...config.podman.extraEgress])];
  }

  async run(request: AttemptRequest): Promise<AttemptResult> {
    const attempt: RunningAttempt = { container: `ai-scanner-${request.scanId}-${request.attempt}`, stopped: false };
    this.running.set(request.scanId, attempt); // before any await: see Runner.stop
    try {
      // A failed preparation is retried by the next Attempt.
      await (this.ready ??= this.prepare().catch((e) => {
        this.ready = undefined;
        throw e;
      }));
      const model = this.models.get(request.model);
      if (!model) throw new Error(`Model ${request.model} is not in the Model Pool`);
      const configPath = join(dirname(request.transcriptPath), 'opencode.json');
      await writeFile(configPath, JSON.stringify(opencodeConfig(model), null, 2));

      await this.exec(['create', ...this.containerArgs(request, attempt.container, configPath, model)]);
      if (attempt.stopped) return { exitCode: 137 };
      return { exitCode: await this.startAttached(attempt.container, request.transcriptPath) };
    } finally {
      if (this.running.get(request.scanId) === attempt) this.running.delete(request.scanId);
      await this.remove(attempt.container);
    }
  }

  async stop(scanId: string): Promise<void> {
    const attempt = this.running.get(scanId);
    if (!attempt) return;
    attempt.stopped = true;
    await this.remove(attempt.container);
  }

  private containerArgs(request: AttemptRequest, name: string, configPath: string, model: ModelEntry): string[] {
    const proxy = `http://${PROXY_CONTAINER}:${PROXY_PORT}`;
    const env: Record<string, string> = {
      HOME: IN_CONTAINER.home,
      OPENCODE_CONFIG: IN_CONTAINER.config,
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
    };
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
      '--volume', `${configPath}:${IN_CONTAINER.config}:ro`,
      '--workdir', IN_CONTAINER.workspace,
    ];
    if (request.skillsDir) args.push('--volume', `${request.skillsDir}:${IN_CONTAINER.skills}:ro`);
    for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
    // Name only: podman copies the value from its own environment, so secrets stay off the command line.
    for (const key of this.podman.agentEnv) args.push('--env', key);
    args.push(this.podman.agentImage, ...this.agentCommand(request, model));
    return args;
  }

  /** The command the agent container runs. */
  protected agentCommand(request: AttemptRequest, model: ModelEntry): string[] {
    return ['opencode', 'run', '--model', `${model.provider}/${model.id}`, request.prompt];
  }

  /**
   * Once per process: removes agent containers a previous process left behind, and (re)creates
   * the networks and the egress proxy with the current allow list.
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
    await this.remove(PROXY_CONTAINER);
    await this.exec([
      'run', '--detach', '--name', PROXY_CONTAINER,
      '--network', `${EGRESS_NETWORK},${AGENT_NETWORK}`,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--volume', `${PROXY_SCRIPT}:/proxy.js:ro`,
      '--env', `ALLOW=${this.egress.join(',')}`,
      '--env', `PORT=${PROXY_PORT}`,
      this.podman.proxyImage, 'node', '/proxy.js',
    ]);
    this.log.log(`Egress proxy allows: ${this.egress.join(', ')}`);
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
