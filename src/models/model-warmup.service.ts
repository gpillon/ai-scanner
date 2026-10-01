import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AgentModel } from '../runner/runner';
import { isBuiltInKind, KIND_INFO } from './provider-kinds';

/** A model that answered with an error retrying will not fix: the Scan fails without an Attempt. */
export class ModelUnusableError extends Error {}

/** Statuses a model gives while it scales up or is busy: the warm-up waits and tries again. */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_MS = 30_000;
const MAX_BODY = 300;

interface WarmupRequest {
  url: string;
  headers: Record<string, string>;
  body: object;
}

/**
 * Wakes a model before a Scan's first Attempt (ADR-0009): a real completion of one token, sent
 * by the server, so no agent pod or container starts before the model answers. Models served
 * with scale-to-zero (Knative, KServe...) can take many minutes to answer the first request.
 * The warm-up waits for them up to its timeout, retrying while the model is unavailable, and
 * fails at once on an answer retrying cannot fix (a wrong key, an unknown model).
 */
@Injectable()
export class ModelWarmup {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Whether Scans warm their model up at all (SCANNER_WARMUP_TIMEOUT_MINUTES > 0). */
  get enabled(): boolean {
    return this.config.warmupTimeoutMs > 0;
  }

  /**
   * Resolves once the model answered a completion. Rejects with ModelUnusableError when it
   * cannot be used, or when it did not answer within the warm-up timeout. `log` receives one
   * line per step, for the Scan's activity; it never holds the key.
   */
  async warm(model: AgentModel, signal: AbortSignal, log: (text: string) => void): Promise<void> {
    const started = Date.now();
    const deadline = started + this.config.warmupTimeoutMs;
    let request = this.request(model);
    const where = new URL(request.url).host;
    log(`Warming up ${model.provider}/${model.name} at ${where}`);
    for (let attempt = 1; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new ModelUnusableError(`${model.provider}/${model.name} did not answer within ${minutes(this.config.warmupTimeoutMs)}`);
      let status: number;
      let text: string;
      try {
        const res = await fetch(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...request.headers },
          body: JSON.stringify(request.body),
          // The request itself may wait long: a scaled-to-zero model holds it until it is up.
          signal: AbortSignal.any([signal, AbortSignal.timeout(left)]),
        });
        status = res.status;
        text = (await res.text().catch(() => '')).slice(0, MAX_BODY);
        if (res.ok) {
          log(`${model.provider}/${model.name} is ready (${seconds(Date.now() - started)})`);
          return;
        }
        // Newer OpenAI models refuse `max_tokens`; ask once more with its successor.
        if (status === 400 && /max_tokens/.test(text) && 'max_tokens' in request.body) {
          const { max_tokens: _, ...rest } = request.body as Record<string, unknown>;
          request = { ...request, body: { ...rest, max_completion_tokens: 1 } };
          continue;
        }
        if (!RETRYABLE.has(status)) {
          throw new ModelUnusableError(`${model.provider}/${model.name} answered ${status}: ${oneLine(text) || 'no details'}`);
        }
      } catch (e) {
        if (e instanceof ModelUnusableError) throw e;
        if (signal.aborted) throw e;
        if (Date.now() >= deadline) {
          throw new ModelUnusableError(`${model.provider}/${model.name} did not answer within ${minutes(this.config.warmupTimeoutMs)}`);
        }
        status = 0;
        text = (e as Error).message;
      }
      const wait = Math.min(this.config.warmupRetryMs * 2 ** Math.min(attempt - 1, 5), MAX_RETRY_MS, Math.max(0, deadline - Date.now()));
      log(`${status ? `Answered ${status}` : `Not reachable (${oneLine(text)})`}: trying again in ${seconds(wait)}`);
      await sleep(wait, signal);
    }
  }

  /** A one-token completion in the API the model's provider speaks. */
  private request(model: AgentModel): WarmupRequest {
    const kind = model.builtIn && isBuiltInKind(model.provider) ? model.provider : 'openai-compatible';
    const base = (model.baseUrl ?? KIND_INFO[kind].defaultBaseUrl)?.replace(/\/+$/, '');
    if (!base) throw new ModelUnusableError(`${model.provider}/${model.name} has no base URL`);
    const key = model.apiKey ?? (model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined);
    const prompt = 'Reply with OK.';
    switch (KIND_INFO[kind].discovery) {
      case 'anthropic':
        return {
          url: `${base}/messages`,
          headers: { 'anthropic-version': '2023-06-01', ...(key && { 'x-api-key': key }) },
          body: { model: model.name, max_tokens: 1, messages: [{ role: 'user', content: prompt }] },
        };
      case 'google':
        return {
          url: `${base}/models/${encodeURIComponent(model.name)}:generateContent`,
          headers: key ? { 'x-goog-api-key': key } : {},
          body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1 } },
        };
      default:
        return {
          url: `${base}/chat/completions`,
          headers: key ? { authorization: `Bearer ${key}` } : {},
          body: { model: model.name, max_tokens: 1, stream: false, messages: [{ role: 'user', content: prompt }] },
        };
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const seconds = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const minutes = (ms: number) => `${ms / 60_000} min`;
