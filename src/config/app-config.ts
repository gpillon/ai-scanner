import { resolve } from 'node:path';
import { APP_ROOT } from '../common/app-root';

export const APP_CONFIG = Symbol('APP_CONFIG');

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export interface ModelEntry {
  id: string;
  provider: string;
  baseUrl?: string;
  /** Server environment variable holding the API key, for providers opencode does not know. */
  apiKeyEnv?: string;
}

export const RUNNER_KINDS = ['podman', 'fake'] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

/** How the Podman Runner runs agent containers (ADR-0003). */
export interface PodmanConfig {
  /** The `podman` executable. */
  executable: string;
  /** Image with opencode installed, built from `containers/agent`. */
  agentImage: string;
  /** Image with Node, running the egress proxy from `containers/egress-proxy`. */
  proxyImage: string;
  /** Names of server environment variables passed to the agent, such as model API keys. */
  agentEnv: string[];
  /** Memory limit of each agent container, in podman's syntax (e.g. `4g`). */
  memory: string;
}

export interface AppConfig {
  token: string;
  /** Opens the admin routes as well (ADR-0006); without it, administration is disabled. */
  adminToken?: string;
  /** `podman` runs the agent in a container per Attempt; `fake` writes a placeholder Report. */
  runner: RunnerKind;
  podman: PodmanConfig;
  dataDir: string;
  profilesDir: string;
  /** The built web UI, served under /ui/ when the directory exists. */
  uiDir?: string;
  models: ModelEntry[];
  defaultModel: string;
  defaultLanguage: string;
  maxArchiveBytes: number;
  /** The Source Archive may extract to at most this many bytes... */
  maxExtractedBytes: number;
  /** ...and hold at most this many entries (files and directories). */
  maxExtractedFiles: number;
  maxInstructionsLength: number;
  retentionDays: number;
  /** Attempts per Scan before it is `failed`. */
  maxAttempts: number;
  /** A running Attempt is stopped after this long and counts as an Attempt without valid output. */
  attemptTimeoutMs: number;
  /** A Scan still running this long after it started is `failed`, even if Attempts remain. */
  scanTimeoutMs: number;
  /** Scans running at once; the rest wait `queued`. */
  concurrency: number;
  /** 0 disables the periodic retention sweep. */
  sweepIntervalMs: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric config value: ${value}`);
  return n;
}

function positive(value: string | undefined, fallback: number): number {
  const n = num(value, fallback);
  if (n === 0) throw new Error(`Expected a positive config value: ${value}`);
  return n;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = positive(value, fallback);
  if (!Number.isInteger(n)) throw new Error(`Expected a positive integer config value: ${value}`);
  return n;
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const token = env.SCANNER_TOKEN;
  if (!token) throw new Error('SCANNER_TOKEN is required');
  const adminToken = env.SCANNER_ADMIN_TOKEN || undefined;
  if (adminToken === token) throw new Error('SCANNER_ADMIN_TOKEN must differ from SCANNER_TOKEN');

  const models: ModelEntry[] = env.SCANNER_MODELS ? JSON.parse(env.SCANNER_MODELS) : [];
  const defaultModel = env.SCANNER_DEFAULT_MODEL ?? models[0]?.id;
  if (!defaultModel || !models.some((m) => m.id === defaultModel)) {
    throw new Error('SCANNER_MODELS must be non-empty and contain SCANNER_DEFAULT_MODEL');
  }

  const runner = (env.SCANNER_RUNNER || 'podman') as RunnerKind;
  if (!RUNNER_KINDS.includes(runner)) {
    throw new Error(`SCANNER_RUNNER must be one of ${RUNNER_KINDS.join(', ')}: ${env.SCANNER_RUNNER}`);
  }

  return {
    token,
    adminToken,
    runner,
    podman: {
      executable: env.SCANNER_PODMAN || 'podman',
      agentImage: env.SCANNER_AGENT_IMAGE || 'localhost/ai-scanner-agent:latest',
      proxyImage: env.SCANNER_EGRESS_PROXY_IMAGE || 'docker.io/library/node:22-alpine',
      agentEnv: list(env.SCANNER_AGENT_ENV),
      memory: env.SCANNER_AGENT_MEMORY || '4g',
    },
    dataDir: resolve(env.SCANNER_DATA_DIR ?? 'data'),
    profilesDir: resolve(env.SCANNER_PROFILES_DIR ?? resolve(APP_ROOT, 'profiles')),
    uiDir: resolve(env.SCANNER_UI_DIR ?? resolve(APP_ROOT, 'ui', 'dist')),
    models,
    defaultModel,
    defaultLanguage: env.SCANNER_DEFAULT_LANGUAGE ?? 'en',
    maxArchiveBytes: num(env.SCANNER_MAX_ARCHIVE_MB, 200) * 1024 * 1024,
    maxExtractedBytes: positive(env.SCANNER_MAX_EXTRACTED_MB, 1024) * 1024 * 1024,
    maxExtractedFiles: positiveInt(env.SCANNER_MAX_EXTRACTED_FILES, 100_000),
    maxInstructionsLength: num(env.SCANNER_MAX_INSTRUCTIONS_LENGTH, 2000),
    retentionDays: num(env.SCANNER_RETENTION_DAYS, 365),
    sweepIntervalMs: num(env.SCANNER_SWEEP_INTERVAL_MINUTES, 60) * MINUTE_MS,
    maxAttempts: positiveInt(env.SCANNER_MAX_ATTEMPTS, 3),
    attemptTimeoutMs: positive(env.SCANNER_ATTEMPT_TIMEOUT_MINUTES, 20) * MINUTE_MS,
    scanTimeoutMs: positive(env.SCANNER_SCAN_TIMEOUT_MINUTES, 60) * MINUTE_MS,
    concurrency: positiveInt(env.SCANNER_CONCURRENCY, 2),
  };
}
