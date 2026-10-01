import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Clock } from '../common/clock';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AgentModel } from '../runner/runner';
import { Scan } from '../scans/entities/scan.entity';
import { PoolModel } from './entities/pool-model.entity';
import { PoolSeed } from './entities/pool-seed.entity';
import { Provider } from './entities/provider.entity';
import { endpointOf, isBuiltInKind } from './provider-kinds';
import { ProvidersService } from './providers.service';

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export interface ModelInput {
  provider: string;
  /** The model's name at the Provider. */
  name: string;
  /** The Model Pool id; the name when not given. */
  id?: string;
  enabled?: boolean;
  default?: boolean;
}

export interface ModelChange {
  enabled?: boolean;
  default?: boolean;
}

/**
 * The Model Pool, stored in the database and managed by the admin (ADR-0006). SCANNER_MODELS
 * seeds it on the very first start only.
 */
@Injectable()
export class ModelPool implements OnModuleInit {
  private readonly log = new Logger(ModelPool.name);

  constructor(
    @InjectRepository(PoolModel) private readonly models: Repository<PoolModel>,
    @InjectRepository(Provider) private readonly providerRows: Repository<Provider>,
    @InjectRepository(Scan) private readonly scans: Repository<Scan>,
    @InjectDataSource() private readonly db: DataSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly providers: ProvidersService,
    private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  /** Imports SCANNER_MODELS, once: later edits to it are ignored. */
  private async seed(): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (await tx.existsBy(PoolSeed, { id: 1 })) return;
      const now = this.clock.now().toISOString();
      const providerIds = new Map<string, string>();
      let position = 0;
      for (const entry of this.config.models) {
        const signature = JSON.stringify([entry.provider, entry.baseUrl ?? null, entry.apiKeyEnv ?? null]);
        let providerId = providerIds.get(signature);
        if (!providerId) {
          providerId = entry.provider;
          for (let n = 2; [...providerIds.values()].includes(providerId); n++) providerId = `${entry.provider}-${n}`;
          providerIds.set(signature, providerId);
          await tx.insert(Provider, {
            id: providerId,
            kind: isBuiltInKind(entry.provider) ? entry.provider : 'openai-compatible',
            baseUrl: entry.baseUrl ?? null,
            apiKeySealed: null,
            apiKeyHint: null,
            apiKeyEnv: entry.apiKeyEnv ?? null,
            createdAt: now,
          });
        }
        await tx.insert(PoolModel, {
          id: entry.id,
          providerId,
          name: entry.id,
          enabled: true,
          isDefault: entry.id === this.config.defaultModel,
          position: position++,
          createdAt: now,
        });
      }
      await tx.insert(PoolSeed, { id: 1, seededAt: now });
      if (this.config.models.length) this.log.log(`Model Pool seeded from SCANNER_MODELS: ${this.config.models.map((m) => m.id).join(', ')}`);
    });
  }

  /** What callers may choose from: the enabled models, with the Default Model marked. */
  async list(): Promise<{ id: string; provider: string; default: boolean }[]> {
    const models = await this.models.find({ where: { enabled: true }, order: { position: 'ASC' } });
    return models.map((m) => ({ id: m.id, provider: m.providerId, default: m.isDefault }));
  }

  /** The requested model, or the Default Model; undefined when that is not an enabled model. */
  async resolve(requested?: string): Promise<string | undefined> {
    const model =
      requested === undefined || requested === ''
        ? await this.models.findOneBy({ isDefault: true, enabled: true })
        : await this.models.findOneBy({ id: requested, enabled: true });
    return model?.id;
  }

  /** Every model, enabled or not, for the admin. */
  all(): Promise<PoolModel[]> {
    return this.models.find({ order: { position: 'ASC' } });
  }

  async get(id: string): Promise<PoolModel> {
    const model = await this.models.findOneBy({ id });
    if (!model) throw new NotFoundException(`Model ${id} not found`);
    return model;
  }

  async create(input: ModelInput): Promise<PoolModel> {
    const provider = await this.providers.get(input.provider).catch(() => {
      throw new BadRequestException(`Unknown Provider: ${input.provider}`);
    });
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    const id = input.id?.trim() || name;
    if (!MODEL_ID_PATTERN.test(id)) throw new BadRequestException(`Not a valid model id: ${id}`);
    if (await this.models.existsBy({ id })) throw new ConflictException(`Model ${id} already exists`);
    const last = await this.models.find({ order: { position: 'DESC' }, take: 1 });
    const model = this.models.create({
      id,
      providerId: provider.id,
      name,
      enabled: input.enabled ?? true,
      isDefault: false,
      position: (last[0]?.position ?? -1) + 1,
      createdAt: this.clock.now().toISOString(),
    });
    await this.models.insert(model);
    // The first model becomes the Default Model, so a fresh pool works without another step.
    const makeDefault = input.default ?? !(await this.models.existsBy({ isDefault: true }));
    return makeDefault ? this.update(id, { default: true }) : model;
  }

  async update(id: string, change: ModelChange): Promise<PoolModel> {
    await this.get(id);
    await this.db.transaction(async (tx) => {
      if (change.enabled !== undefined) await tx.update(PoolModel, { id }, { enabled: change.enabled });
      if (change.default === true) {
        await tx.update(PoolModel, { isDefault: true }, { isDefault: false });
        await tx.update(PoolModel, { id }, { isDefault: true, enabled: true });
      } else if (change.default === false) {
        await tx.update(PoolModel, { id }, { isDefault: false });
      }
    });
    return this.get(id);
  }

  /** Refused while a queued or running Scan uses the model: its next Attempt would have none. */
  async remove(id: string): Promise<void> {
    await this.get(id);
    const active = await this.scans.countBy({ model: id, state: In(['queued', 'running']) });
    if (active) throw new ConflictException(`Model ${id} is used by ${active} queued or running Scan(s): disable it instead`);
    await this.models.delete(id);
  }

  /** How the agent reaches a model; whether or not it is enabled, since Scans may already use it. */
  async agentModel(id: string): Promise<AgentModel> {
    const model = await this.models.findOneBy({ id });
    if (!model) throw new Error(`Model ${id} is not in the Model Pool`);
    const provider = await this.providers.get(model.providerId);
    const builtIn = isBuiltInKind(provider.kind);
    const apiKey = this.providers.storedKey(provider);
    return {
      provider: builtIn ? provider.kind : provider.id,
      builtIn,
      name: model.name,
      ...(provider.baseUrl && { baseUrl: provider.baseUrl }),
      ...(apiKey ? { apiKey } : provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    };
  }

  /**
   * Every `host:port` the pool's models are served from: the egress proxy's allow list. All
   * models count, disabled ones too, since running Scans may use them. A Provider without a
   * usable URL is left out, so one bad row does not stop every Scan.
   */
  async endpoints(): Promise<string[]> {
    const used = new Set((await this.models.find({ select: { providerId: true } })).map((m) => m.providerId));
    const endpoints = new Set<string>();
    for (const provider of await this.providerRows.findBy({ id: In([...used]) })) {
      const url = this.providers.baseUrlOf(provider);
      try {
        if (!url) throw new Error('no baseUrl');
        endpoints.add(endpointOf(url));
      } catch (e) {
        this.log.warn(`Provider ${provider.id} is left out of the egress allow list: ${(e as Error).message}`);
      }
    }
    return [...endpoints].sort();
  }
}
