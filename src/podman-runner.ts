import { Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppConfig, ModelEntry, PodmanConfig } from './config';
import { AttemptRequest, AttemptResult, Runner } from './runner';

/** Agent containers join only this network: it has no route out of the host. */
const AGENT_NETWORK = 'ai-scanner-agents';
/** The egress proxy joins this one too, to reach the model endpoints. */
export const EGRESS_NETWORK = 'ai-scanner-egress';
const PROXY_CONTAINER = 'ai-scanner-egress-proxy';
const PROXY_PORT = 3128;
/** Every agent container carries it, with the Scan id as value. */
export const SCAN_LABEL = 'ai-scanner.scan';

const PROXY_SCRIPT = resolve(__dirname, '..', 'containers', 'egress-proxy', 'proxy.js');

/**
 * Providers opencode ships with, and where they send requests unless the Model Pool gives a
 * `baseUrl`. Any other provider is treated as OpenAI-compatible: opencode bundles that SDK,
 * whereas others would be downloaded at runtime, which the egress proxy forbids.
 */
const PROVIDER_ENDPOINTS: Record<string, string> = {
  anthropic: 'api.anthropic.com:443',
  openai: 'api.openai.com:443',
  google: 'generativelanguage.googleapis.com:443',
  mistral: 'api.mistral.ai:443',
  groq: 'api.groq.com:443',
  xai: 'api.x.ai:443',
  openrouter: 'openrouter.ai:443',
};

/** The `host:port` a Model Pool entry's requests go to. */
export function modelEndpoint(model: ModelEntry): string {
  if (model.baseUrl) {
    const url = new URL(model.baseUrl);
    // Without the brackets of an IPv6 literal, as the egress proxy compares hosts.
    return `${url.hostname.replace(/^\[|\]$/g, '')}:${url.port || (url.protocol === 'http:' ? 80 : 443)}`;
  }
  const known = PROVIDER_ENDPOINTS[model.provider];
  if (!known) throw new Error(`Model ${model.id}: provider ${model.provider} needs a baseUrl in SCANNER_MODELS`);
  return known;
}

/** Paths inside the agent container. */
const IN_CONTAINER = {
  workspace: '/workspace',
  output: '/output',
  skills: '/skills',
  home: '/home/agent',
};

/**
 * The opencode configuration of an Attempt: the chosen model, and tools limited to reading the
 * workspace and the skills, and writing under /output. Every rule resolves to allow or deny:
 * `opencode run` rejects what would ask, and ends the Attempt.
 */
/** How opencode names the model: `provider/model`. */
function modelRef(model: ModelEntry): string {
  return `${model.provider}/${model.id}`;
}

function opencodeConfig(model: ModelEntry, withSkills: boolean): object {
  const ref = modelRef(model);
  const builtIn = model.provider in PROVIDER_ENDPOINTS;
  const options = {
    ...(model.baseUrl && { baseURL: model.baseUrl }),
    ...(model.apiKeyEnv && { apiKey: `{env:${model.apiKeyEnv}}` }),
  };
  return {
    $schema: 'https://opencode.ai/config.json',
    model: ref,
    small_model: ref,
    enabled_providers: [model.provider],
    provider: {
      [model.provider]: builtIn
        ? { options }
        : { npm: '@ai-sdk/openai-compatible', name: model.provider, options, models: { [model.id]: { tool_call: true } } },
    },
    ...(withSkills && { skills: { paths: [IN_CONTAINER.skills] } }),
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    lsp: false,
    formatter: false,
    permission: {
      '*': 'deny',
      invalid: 'allow', // opencode's reply to a malformed tool call; `*` would hide it
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      skill: 'allow',
      todowrite: 'allow',
      bash: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      question: 'deny',
      doom_loop: 'deny',
      // Relative to the worktree: `/`, or /workspace when the Source Archive is a git repository.
      edit: { '*': 'deny', 'output/*': 'allow', '../output/*': 'allow' },
      external_directory: { '*': 'deny', [`${IN_CONTAINER.output}/*`]: 'allow', [`${IN_CONTAINER.skills}/*`]: 'allow' },
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
    this.egress = [...new Set(config.models.map(modelEndpoint))];
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

  async stop(scanId: string): Promise<void> {
    const attempt = this.running.get(scanId);
    if (!attempt) return;
    attempt.stopped = true;
    await this.remove(attempt.container);
  }

  private containerArgs(request: AttemptRequest, name: string, model: ModelEntry): string[] {
    const proxy = `http://${PROXY_CONTAINER}:${PROXY_PORT}`;
    const env: Record<string, string> = {
      HOME: IN_CONTAINER.home,
      // Merged last, over any configuration opencode finds; and the Source Archive's own
      // opencode.json, .opencode/, AGENTS.md and skills are never loaded.
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(model, Boolean(request.skillsDir))),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_PURE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_SHARE: '1',
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
      '--workdir', IN_CONTAINER.workspace,
    ];
    if (request.skillsDir) args.push('--volume', `${request.skillsDir}:${IN_CONTAINER.skills}:ro`);
    for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
    args.push(this.podman.agentImage, ...this.agentCommand(request, model));
    return args;
  }

  /**
   * Hands the agent's secrets (SCANNER_AGENT_ENV and the model's apiKeyEnv) to `use` as an env
   * file, removed once `use` settles: they stay off the command line, and a remote podman
   * client (Windows, macOS) would not forward `--env NAME` values from this process.
   */
  private async withSecrets<T>(model: ModelEntry, use: (envFile: string) => Promise<T>): Promise<T> {
    const names = new Set([...this.podman.agentEnv, ...(model.apiKeyEnv ? [model.apiKeyEnv] : [])]);
    const lines: string[] = [];
    for (const name of names) {
      const value = process.env[name];
      if (value === undefined) this.log.warn(`${name} is not set: the agent will run without it`);
      else if (/[\r\n]/.test(value)) throw new Error(`${name} spans several lines, which an env file cannot hold`);
      else lines.push(`${name}=${value}`);
    }
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
  protected agentCommand(request: AttemptRequest, model: ModelEntry): string[] {
    // --title skips a title-generation call; stdin is not attached, so nothing joins the prompt.
    return ['opencode', 'run', '--format', 'json', '--title', request.scanId, '--dir', IN_CONTAINER.workspace, '--model', modelRef(model), request.prompt];
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
      'run', '--detach', '--restart', 'always', '--name', PROXY_CONTAINER,
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
