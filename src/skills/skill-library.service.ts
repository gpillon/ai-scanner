import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { Clock } from '../common/clock';
import { paths } from '../common/paths';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { ProfileRegistry } from '../profiles/profile-registry.service';
import { extractSourceArchive, InvalidSourceArchiveError } from '../scans/source-archive';
import { LibrarySkill } from './entities/library-skill.entity';
import { SkillPack } from './entities/skill-pack.entity';
import { failureOf, runSkillsAdd, SkillsCliError } from './skills-cli';
import { findSkillDirs, FoundSkill, InvalidSkillError, readSkill, SkillLimits } from './skill-files';

/** One skill. */
export const SKILL_LIMITS: SkillLimits = { maxBytes: 10 * 1024 * 1024, maxFiles: 500 };
/** One import, all its skills together. */
const IMPORT_LIMITS = { maxBytes: 100 * 1024 * 1024, maxFiles: 5000 };

/** What `skills add` accepts: a GitHub shorthand, a URL or a path; never an option. */
const SOURCE_PATTERN = /^[^\s-][^\s]{0,499}$/;

export interface ImportResult {
  imported: LibrarySkill[];
}

/**
 * The Skill Library (ADR-0008): skills the admin imports, from a zip or with the `skills` CLI,
 * stored under `paths.skills` and grouped into Skill Packs.
 */
@Injectable()
export class SkillLibrary {
  constructor(
    @InjectRepository(LibrarySkill) private readonly skills: Repository<LibrarySkill>,
    @InjectRepository(SkillPack) private readonly packs: Repository<SkillPack>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly profiles: ProfileRegistry,
    private readonly clock: Clock,
  ) {}

  list(): Promise<LibrarySkill[]> {
    return this.skills.find({ order: { name: 'ASC' } });
  }

  async get(name: string): Promise<LibrarySkill> {
    const skill = await this.skills.findOneBy({ name });
    if (!skill) throw new NotFoundException(`Skill ${name} not found`);
    return skill;
  }

  /** Where the skill's files are. */
  dirOf(name: string): string {
    return join(paths.skills(this.config.dataDir), name);
  }

  /** Its SKILL.md, for the admin to read. */
  async instructions(name: string): Promise<string> {
    await this.get(name);
    return readFile(join(this.dirOf(name), 'SKILL.md'), 'utf8');
  }

  /** The skills every Scan Profile brings: library skills must not shadow them. */
  async profileSkillNames(): Promise<Set<string>> {
    const names = new Set<string>();
    for (const profile of this.profiles.list()) {
      if (!profile.skillsDir) continue;
      for (const entry of await readdir(profile.skillsDir, { withFileTypes: true })) if (entry.isDirectory()) names.add(entry.name);
    }
    return names;
  }

  /** Imports every skill in a zip: each a directory holding a SKILL.md. */
  async importArchive(archivePath: string, filename: string, replace: boolean): Promise<ImportResult> {
    return this.withWorkDir(async (work) => {
      const root = join(work, 'archive');
      try {
        await extractSourceArchive(archivePath, root, IMPORT_LIMITS);
      } catch (e) {
        if (e instanceof InvalidSourceArchiveError) throw new BadRequestException(`Cannot extract the archive: ${e.message}`);
        throw e;
      }
      const dirs = await findSkillDirs(root);
      return this.install(dirs, `upload:${filename}`, replace, work);
    });
  }

  /** Imports with `skills add <source>`: a GitHub `owner/repo`, a Git URL, and so on. */
  async importFromSource(source: string, only: string[], replace: boolean): Promise<ImportResult> {
    if (!SOURCE_PATTERN.test(source)) throw new BadRequestException('source must be a repository, URL or path, without spaces');
    for (const name of only) if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new BadRequestException(`Not a skill name: ${name}`);
    return this.withWorkDir(async (work) => {
      const project = join(work, 'project');
      const home = join(work, 'home');
      await mkdir(project, { recursive: true });
      await mkdir(home, { recursive: true });
      let output: string;
      try {
        output = await runSkillsAdd(source, only, project, home);
      } catch (e) {
        if (e instanceof SkillsCliError) throw new BadGatewayException(e.message);
        throw e;
      }
      // What the CLI says it did is not trusted: the skills are read back from disk.
      const installed = join(project, '.agents', 'skills');
      const dirs = existsSync(installed) ? await findSkillDirs(installed, 1) : [];
      if (!dirs.length) throw new BadGatewayException(`skills add installed nothing: ${failureOf(output)}`);
      return this.install(dirs, source, replace, work);
    });
  }

  async remove(name: string): Promise<void> {
    await this.get(name);
    const users = (await this.packs.find()).filter((p) => p.skills.includes(name)).map((p) => p.id);
    if (users.length) throw new ConflictException(`Skill ${name} is in Skill Pack(s) ${users.join(', ')}: remove it from them first`);
    await this.skills.delete(name);
    await rm(this.dirOf(name), { recursive: true, force: true });
  }

  private async install(dirs: string[], source: string, replace: boolean, work: string): Promise<ImportResult> {
    if (!dirs.length) throw new BadRequestException('No skill found: each one is a directory holding a SKILL.md');
    const found: FoundSkill[] = [];
    for (const dir of dirs) {
      try {
        found.push(await readSkill(dir, SKILL_LIMITS));
      } catch (e) {
        if (e instanceof InvalidSkillError) throw new BadRequestException(`Skill in ${dir.split(/[\\/]/).pop()}: ${e.message}`);
        throw e;
      }
    }
    const names = found.map((s) => s.name);
    const twice = names.filter((n, i) => names.indexOf(n) !== i);
    if (twice.length) throw new BadRequestException(`The import holds ${twice.join(', ')} more than once`);
    const builtIn = await this.profileSkillNames();
    const shadowing = names.filter((n) => builtIn.has(n));
    if (shadowing.length) throw new BadRequestException(`A Scan Profile already brings ${shadowing.join(', ')}`);
    if (!replace) {
      const existing = (await this.skills.findBy(names.map((name) => ({ name })))).map((s) => s.name);
      if (existing.length) throw new ConflictException(`The library already has ${existing.join(', ')}: import with replace to update`);
    }

    const library = paths.skills(this.config.dataDir);
    await mkdir(library, { recursive: true });
    const now = this.clock.now().toISOString();
    const imported: LibrarySkill[] = [];
    for (const skill of found) {
      const target = this.dirOf(skill.name);
      // A directory cannot be renamed onto another (Windows): move the old version aside first.
      if (existsSync(target)) await rename(target, join(work, `previous-${skill.name}`));
      await rename(skill.dir, target);
      const row = this.skills.create({
        name: skill.name,
        description: skill.description,
        source,
        hash: skill.hash,
        files: skill.files,
        bytes: skill.bytes,
        importedAt: now,
      });
      await this.skills.save(row);
      imported.push(row);
    }
    return { imported };
  }

  /** A scratch directory on the library's volume, removed afterwards whatever happens. */
  private async withWorkDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
    const dir = join(paths.skillImports(this.config.dataDir), randomUUID());
    await mkdir(dir, { recursive: true });
    try {
      return await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
