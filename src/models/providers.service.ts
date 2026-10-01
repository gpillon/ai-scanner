import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../common/clock';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PoolModel } from './entities/pool-model.entity';
import { Provider } from './entities/provider.entity';
import { isBuiltInKind, KIND_INFO, PROVIDER_KINDS, ProviderKind } from './provider-kinds';
import { SecretBox } from './secret-box';

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;

export interface ProviderInput {
  id: string;
  kind: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface ProviderChange {
  baseUrl?: string | null;
  /** A new key; `null` removes the stored one. */
  apiKey?: string | null;
}

export interface DiscoveredModel {
  /** The model's name at the Provider. */
  name: string;
  displayName?: string;
}

function checkBaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestException(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new BadRequestException('baseUrl must be http or https');
  return url.replace(/\/+$/, '');
}

/** The Providers behind the Model Pool (ADR-0006): how to reach them, their keys, their models. */
@Injectable()
export class ProvidersService {
  private readonly box?: SecretBox;

  constructor(
    @InjectRepository(Provider) private readonly providers: Repository<Provider>,
    @InjectRepository(PoolModel) private readonly models: Repository<PoolModel>,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly clock: Clock,
  ) {
    this.box = config.secretKey ? new SecretBox(config.secretKey) : undefined;
  }

  list(): Promise<Provider[]> {
    return this.providers.find({ order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async get(id: string): Promise<Provider> {
    const provider = await this.providers.findOneBy({ id });
    if (!provider) throw new NotFoundException(`Provider ${id} not found`);
    return provider;
  }

  async create(input: ProviderInput): Promise<Provider> {
    if (!PROVIDER_ID_PATTERN.test(input.id)) {
      throw new BadRequestException('Provider id must be 1-32 characters: lowercase letters, digits and dashes');
    }
    if (!(PROVIDER_KINDS as readonly string[]).includes(input.kind)) {
      throw new BadRequestException(`kind must be one of ${PROVIDER_KINDS.join(', ')}`);
    }
    const kind = input.kind as ProviderKind;
    // opencode would take an OpenAI-compatible provider named like a built-in one for the built-in.
    if (kind === 'openai-compatible' && isBuiltInKind(input.id)) {
      throw new BadRequestException(`An openai-compatible Provider cannot be called ${input.id}`);
    }
    const baseUrl = input.baseUrl ? checkBaseUrl(input.baseUrl) : null;
    if (kind === 'openai-compatible' && !baseUrl) throw new BadRequestException('An openai-compatible Provider needs a baseUrl');
    if (await this.providers.existsBy({ id: input.id })) throw new ConflictException(`Provider ${input.id} already exists`);

    const provider = this.providers.create({
      id: input.id,
      kind,
      baseUrl,
      apiKeySealed: null,
      apiKeyHint: null,
      apiKeyEnv: null,
      createdAt: this.clock.now().toISOString(),
    });
    if (input.apiKey) this.setKey(provider, input.apiKey);
    await this.providers.insert(provider);
    return provider;
  }

  async update(id: string, change: ProviderChange): Promise<Provider> {
    const provider = await this.get(id);
    if (change.baseUrl !== undefined) {
      const baseUrl = change.baseUrl ? checkBaseUrl(change.baseUrl) : null;
      if (provider.kind === 'openai-compatible' && !baseUrl) throw new BadRequestException('An openai-compatible Provider needs a baseUrl');
      provider.baseUrl = baseUrl;
    }
    if (change.apiKey === null) {
      provider.apiKeySealed = null;
      provider.apiKeyHint = null;
    } else if (change.apiKey) {
      this.setKey(provider, change.apiKey);
    }
    await this.providers.save(provider);
    return provider;
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    const used = await this.models.countBy({ providerId: id });
    if (used) throw new ConflictException(`Provider ${id} still serves ${used} model(s): remove them first`);
    await this.providers.delete(id);
  }

  modelCount(id: string): Promise<number> {
    return this.models.countBy({ providerId: id });
  }

  /** Where the Provider's API is: its own baseUrl, or its kind's. */
  baseUrlOf(provider: Provider): string | undefined {
    return provider.baseUrl ?? KIND_INFO[provider.kind].defaultBaseUrl;
  }

  /** The stored key in clear, if one is stored. Throws when it cannot be decrypted. */
  storedKey(provider: Provider): string | undefined {
    if (!provider.apiKeySealed) return undefined;
    if (!this.box) throw new Error(`Provider ${provider.id} has a stored API key, but SCANNER_SECRET_KEY is not set`);
    try {
      return this.box.open(provider.apiKeySealed, provider.id);
    } catch {
      throw new Error(`The API key of Provider ${provider.id} cannot be decrypted: SCANNER_SECRET_KEY changed?`);
    }
  }

  /** The key model discovery uses: stored, else from the server environment. */
  private discoveryKey(provider: Provider): string | undefined {
    const env = provider.apiKeyEnv ?? KIND_INFO[provider.kind].apiKeyEnv;
    return this.storedKey(provider) ?? (env ? process.env[env] : undefined);
  }

  /** The models the Provider offers, as its API lists them. */
  async discover(id: string): Promise<DiscoveredModel[]> {
    const provider = await this.get(id);
    const base = this.baseUrlOf(provider);
    if (!base) throw new BadRequestException(`Provider ${id} has no baseUrl`);
    let key: string | undefined;
    try {
      key = this.discoveryKey(provider);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const style = KIND_INFO[provider.kind].discovery;
    const headers: Record<string, string> = {};
    let url: string;
    if (style === 'anthropic') {
      url = `${base}/models?limit=1000`;
      headers['anthropic-version'] = '2023-06-01';
      if (key) headers['x-api-key'] = key;
    } else if (style === 'google') {
      url = `${base}/models?pageSize=1000`;
      if (key) headers['x-goog-api-key'] = key; // a header, so the key stays out of URLs and logs
    } else {
      url = `${base}/models`;
      if (key) headers.authorization = `Bearer ${key}`;
    }
    const body = await this.fetchJson(url, headers, id);
    return parseModelList(style, body);
  }

  private async fetchJson(url: string, headers: Record<string, string>, id: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    } catch (e) {
      throw new BadGatewayException(`Could not reach Provider ${id}: ${(e as Error).message}`);
    }
    const text = await readCapped(res);
    if (!res.ok) throw new BadGatewayException(`Provider ${id} answered ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new BadGatewayException(`Provider ${id} did not answer with JSON`);
    }
  }

  private setKey(provider: Provider, key: string): void {
    if (!this.box) throw new BadRequestException('Storing API keys needs SCANNER_SECRET_KEY on the server');
    provider.apiKeySealed = this.box.seal(key, provider.id);
    provider.apiKeyHint = key.length > 8 ? key.slice(-4) : null;
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > DISCOVERY_MAX_BYTES) {
      await reader.cancel();
      throw new BadGatewayException('The model list is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseModelList(style: 'openai' | 'anthropic' | 'google', body: any): DiscoveredModel[] {
  const list: DiscoveredModel[] = [];
  if (style === 'google') {
    for (const m of Array.isArray(body?.models) ? body.models : []) {
      if (typeof m?.name !== 'string') continue;
      if (Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes('generateContent')) continue;
      list.push({ name: m.name.replace(/^models\//, ''), displayName: m.displayName });
    }
  } else {
    for (const m of Array.isArray(body?.data) ? body.data : []) {
      if (typeof m?.id !== 'string') continue;
      list.push({ name: m.id, displayName: style === 'anthropic' ? m.display_name : m.name });
    }
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}
