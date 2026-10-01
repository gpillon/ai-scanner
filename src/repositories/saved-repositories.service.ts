import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Role } from '../auth/bearer.guard';
import { Clock } from '../common/clock';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SecretBox } from '../models/secret-box';
import { GitCredentials, GitRefs } from '../scans/git-source';
import { GitSources } from '../scans/git-sources.service';
import { ScanSchedule } from '../schedules/entities/scan-schedule.entity';
import { SavedRepository } from './entities/saved-repository.entity';

export const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface RepositoryInput {
  id: string;
  description?: string;
  url: string;
  ref?: string | null;
  username?: string | null;
  token?: string | null;
}

export interface RepositoryChange {
  description?: string;
  url?: string;
  /** null: the default branch. */
  ref?: string | null;
  username?: string | null;
  /** A new token; null removes the stored one. */
  token?: string | null;
}

/** What a Scan needs to fetch a Saved Repository: its URL, ref and credentials in clear. */
export interface RepositoryAccess {
  url: string;
  ref: string | null;
  credentials: GitCredentials;
}

/** Who asks: a token holder, or the server itself for a Scan Schedule an admin set up. */
export type Requester = Role | 'scheduler';

const blankToNull = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/**
 * Saved Repositories (ADR-0014): Source Repositories kept under a name, with their credentials
 * sealed like Provider API keys, so that Scans and Scan Schedules can name them.
 */
@Injectable()
export class SavedRepositories {
  private readonly box?: SecretBox;

  constructor(
    @InjectRepository(SavedRepository) private readonly repos: Repository<SavedRepository>,
    @InjectRepository(ScanSchedule) private readonly schedules: Repository<ScanSchedule>,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly git: GitSources,
    private readonly clock: Clock,
  ) {
    this.box = config.secretKey ? new SecretBox(config.secretKey) : undefined;
  }

  list(): Promise<SavedRepository[]> {
    return this.repos.find({ order: { id: 'ASC' } });
  }

  async get(id: string): Promise<SavedRepository> {
    const repo = await this.repos.findOneBy({ id });
    if (!repo) throw new NotFoundException(`Repository ${id} not found`);
    return repo;
  }

  /** A private repository (one with a stored token) is the admin's: to use it and to manage it. */
  assertMayUse(repo: SavedRepository, by: Requester): void {
    if (repo.tokenSealed && by === 'caller') throw new ForbiddenException(`Repository ${repo.id} is private: it needs the admin token`);
  }

  async create(input: RepositoryInput, by: Requester): Promise<SavedRepository> {
    if (!REPOSITORY_ID_PATTERN.test(input.id ?? '')) {
      throw new BadRequestException('Repository id must be 1-64 characters: lowercase letters, digits and dashes');
    }
    if (await this.repos.existsBy({ id: input.id })) throw new ConflictException(`Repository ${input.id} already exists`);
    const token = blankToNull(input.token);
    if (token && by === 'caller') throw new ForbiddenException('Storing a repository token needs the admin token');
    const repo = this.repos.create({
      id: input.id,
      description: input.description?.trim() ?? '',
      url: await this.git.checkUrl(input.url?.trim() ?? '', Boolean(token)),
      ref: this.git.checkRefName(blankToNull(input.ref)),
      username: blankToNull(input.username),
      tokenSealed: null,
      tokenHint: null,
      createdAt: this.clock.now().toISOString(),
    });
    if (token) this.setToken(repo, token);
    await this.repos.insert(repo);
    return repo;
  }

  async update(id: string, change: RepositoryChange, by: Requester): Promise<SavedRepository> {
    const repo = await this.get(id);
    this.assertMayUse(repo, by);
    if (change.token?.trim() && by === 'caller') throw new ForbiddenException('Storing a repository token needs the admin token');
    if (change.description !== undefined) repo.description = change.description.trim();
    if (change.ref !== undefined) repo.ref = this.git.checkRefName(blankToNull(change.ref));
    if (change.username !== undefined) repo.username = blankToNull(change.username);
    if (change.token === null) {
      repo.tokenSealed = null;
      repo.tokenHint = null;
    } else if (change.token?.trim()) {
      this.setToken(repo, change.token.trim());
    }
    if (change.url !== undefined || change.token !== undefined) {
      const url = await this.git.checkUrl(change.url?.trim() ?? repo.url, Boolean(repo.tokenSealed));
      // The stored token goes only where it was given for: another host needs it typed again.
      if (repo.tokenSealed && !change.token?.trim() && new URL(url).host !== new URL(repo.url).host) {
        throw new BadRequestException('Moving a repository with a stored token to another host needs the token again, or its removal');
      }
      repo.url = url;
    }
    await this.repos.save(repo);
    return repo;
  }

  async remove(id: string, by: Requester): Promise<void> {
    this.assertMayUse(await this.get(id), by);
    const users = await this.schedules.findBy({ repository: id });
    if (users.length) {
      throw new ConflictException(`Repository ${id} is used by Scan Schedule(s) ${users.map((s) => s.id).join(', ')}: remove them first`);
    }
    await this.repos.delete(id);
  }

  /** How to fetch it; a 403 when it is private and `by` a caller, a 400 when its token cannot be opened. */
  async access(id: string, by: Requester): Promise<RepositoryAccess> {
    const repo = await this.repos.findOneBy({ id });
    if (!repo) throw new BadRequestException(`Unknown repository: ${id}`);
    this.assertMayUse(repo, by);
    return { url: repo.url, ref: repo.ref, credentials: { username: repo.username ?? undefined, token: this.storedToken(repo) } };
  }

  /** Its branches and tags, fetched with its stored credentials. */
  async refs(id: string, by: Requester): Promise<GitRefs> {
    await this.get(id);
    const { url, credentials } = await this.access(id, by);
    return this.git.refs(url, credentials);
  }

  private storedToken(repo: SavedRepository): string | undefined {
    if (!repo.tokenSealed) return undefined;
    if (!this.box) throw new BadRequestException(`Repository ${repo.id} has a stored token, but SCANNER_SECRET_KEY is not set`);
    try {
      return this.box.open(repo.tokenSealed, `repository:${repo.id}`);
    } catch {
      throw new BadRequestException(`The token of repository ${repo.id} cannot be decrypted: SCANNER_SECRET_KEY changed?`);
    }
  }

  private setToken(repo: SavedRepository, token: string): void {
    if (!this.box) throw new BadRequestException('Storing repository credentials needs SCANNER_SECRET_KEY on the server');
    // Bound to this repository: a ciphertext copied to another row, or a Provider's, does not open.
    repo.tokenSealed = this.box.seal(token, `repository:${repo.id}`);
    repo.tokenHint = token.length > 8 ? token.slice(-4) : null;
  }
}
