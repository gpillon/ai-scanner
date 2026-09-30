import { resolve } from 'node:path';

export const APP_CONFIG = Symbol('APP_CONFIG');

export const DAY_MS = 24 * 60 * 60 * 1000;

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
  maxInstructionsLength: number;
  retentionDays: number;
  /** 0 disables the periodic retention sweep. */
  sweepIntervalMs: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric config value: ${value}`);
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
    maxInstructionsLength: num(env.SCANNER_MAX_INSTRUCTIONS_LENGTH, 2000),
    retentionDays: num(env.SCANNER_RETENTION_DAYS, 365),
    sweepIntervalMs: num(env.SCANNER_SWEEP_INTERVAL_MINUTES, 60) * 60 * 1000,
  };
}
