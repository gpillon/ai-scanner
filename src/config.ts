import { resolve } from 'node:path';

export const APP_CONFIG = Symbol('APP_CONFIG');

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export interface ModelEntry {
  id: string;
  provider: string;
  baseUrl?: string;
}

export interface AppConfig {
  token: string;
  dataDir: string;
  profilesDir: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const token = env.SCANNER_TOKEN;
  if (!token) throw new Error('SCANNER_TOKEN is required');

  const models: ModelEntry[] = env.SCANNER_MODELS ? JSON.parse(env.SCANNER_MODELS) : [];
  const defaultModel = env.SCANNER_DEFAULT_MODEL ?? models[0]?.id;
  if (!defaultModel || !models.some((m) => m.id === defaultModel)) {
    throw new Error('SCANNER_MODELS must be non-empty and contain SCANNER_DEFAULT_MODEL');
  }

  return {
    token,
    dataDir: resolve(env.SCANNER_DATA_DIR ?? 'data'),
    profilesDir: resolve(env.SCANNER_PROFILES_DIR ?? resolve(__dirname, '..', 'profiles')),
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
