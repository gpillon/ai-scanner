import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Repository } from 'typeorm';
import { ArtifactStore } from '../artifacts/artifact-store';
import { Clock } from '../common/clock';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { ModelPool } from '../models/model-pool.service';
import { paths } from '../common/paths';
import { ProfileRegistry } from '../profiles/profile-registry.service';
import { Scan } from './entities/scan.entity';
import { ScanSupervisor } from './scan-supervisor.service';

export const SCAN_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/** Artifact names a caller may download, with their content types. */
export const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
  'report.md': 'text/markdown; charset=utf-8',
  'report.pdf': 'application/pdf',
  'findings.json': 'application/json; charset=utf-8',
};

export interface CreateScanInput {
  id: string;
  archivePath?: string;
  profile: string;
  model?: string;
  language?: string;
  instructions?: string;
}

const ZIP_MAGICS = [Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('PK\x05\x06', 'latin1')];

async function looksLikeZip(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await file.read(head, 0, 4, 0);
    return bytesRead === 4 && ZIP_MAGICS.some((m) => m.equals(head));
  } finally {
    await file.close();
  }
}

@Injectable()
export class ScansService {
  constructor(
    @InjectRepository(Scan) private readonly scans: Repository<Scan>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly profiles: ProfileRegistry,
    private readonly models: ModelPool,
    private readonly store: ArtifactStore,
    private readonly supervisor: ScanSupervisor,
    private readonly clock: Clock,
  ) {}

  async create(input: CreateScanInput): Promise<Scan> {
    if (!SCAN_ID_PATTERN.test(input.id)) {
      throw new BadRequestException('Scan id must be 1-64 characters: lowercase letters, digits and dashes');
    }
    if (!input.archivePath) throw new BadRequestException('Source Archive is required (multipart field "file")');
    if (!(await looksLikeZip(input.archivePath))) throw new BadRequestException('Source Archive must be a zip file');
    if (!this.profiles.get(input.profile)) throw new BadRequestException(`Unknown Scan Profile: ${input.profile}`);
    const model = await this.models.resolve(input.model);
    if (!model) {
      throw new BadRequestException(
        input.model ? `Model is not in the Model Pool: ${input.model}` : 'The Model Pool has no Default Model: choose a model',
      );
    }
    const instructions = input.instructions || null;
    if (instructions && instructions.length > this.config.maxInstructionsLength) {
      throw new BadRequestException(`Instructions exceed ${this.config.maxInstructionsLength} characters`);
    }

    const scan = this.scans.create({
      id: input.id,
      state: 'queued',
      profile: input.profile,
      model,
      language: input.language ?? this.config.defaultLanguage,
      instructions,
      attempts: 0,
      createdAt: this.clock.now().toISOString(),
      startedAt: null,
      finishedAt: null,
      failureReason: null,
    });
    if (await this.scans.existsBy({ id: input.id })) throw new ConflictException(`Scan ${input.id} already exists`);
    // The queue must not start the Scan before its Source Archive is in place; releasing wakes it.
    const release = this.supervisor.hold(input.id);
    try {
      // The primary key makes the id claim atomic: a concurrent duplicate loses here.
      try {
        await this.scans.insert(scan);
      } catch (e) {
        // Lost a race with a concurrent POST of the same id; anything else is a real failure.
        if ((e as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
          throw new ConflictException(`Scan ${input.id} already exists`);
        }
        throw e;
      }

      try {
        const target = paths.sourceArchive(this.config.dataDir, input.id);
        await mkdir(dirname(target), { recursive: true });
        await rename(input.archivePath, target);
      } catch (e) {
        await this.scans.delete(input.id);
        throw e;
      }
    } finally {
      release();
    }
    return scan;
  }

  async get(id: string): Promise<Scan> {
    const scan = await this.scans.findOneBy({ id });
    if (!scan) throw new NotFoundException(`Scan ${id} not found`);
    return scan;
  }

  /** Every Scan any caller started, newest first: whoever holds the token sees them all. */
  list(): Promise<Scan[]> {
    return this.scans.find({ order: { createdAt: 'DESC', id: 'ASC' } });
  }

  async artifactNames(scan: Scan): Promise<string[]> {
    return scan.state === 'succeeded' ? this.store.list(scan.id) : [];
  }

  async artifact(id: string, name: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
    const scan = await this.get(id);
    const contentType = Object.hasOwn(ARTIFACT_CONTENT_TYPES, name) ? ARTIFACT_CONTENT_TYPES[name] : undefined;
    if (!contentType || !(await this.artifactNames(scan)).includes(name)) {
      throw new NotFoundException(`Artifact ${name} not found`);
    }
    return { stream: this.store.stream(id, name), contentType };
  }

  /** Stops the Scan if it is queued or runs, then removes it with all its data. The id is free afterwards. */
  async delete(id: string): Promise<void> {
    await this.get(id);
    const release = await this.supervisor.cancel(id);
    try {
      await rm(paths.scanDir(this.config.dataDir, id), { recursive: true, force: true });
      await this.store.delete(id);
      await this.scans.delete(id);
    } finally {
      release();
    }
  }

  /** Ids of Scans created before `cutoff` (ISO-8601). */
  async idsCreatedBefore(cutoff: string): Promise<string[]> {
    const rows = await this.scans
      .createQueryBuilder('scan')
      .select('scan.id', 'id')
      .where('scan.createdAt < :cutoff', { cutoff })
      .getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }
}
