import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { In, Repository } from 'typeorm';
import { Clock } from '../common/clock';
import { LibrarySkill } from './entities/library-skill.entity';
import { SkillPack } from './entities/skill-pack.entity';
import { SkillLibrary } from './skill-library.service';

export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkillPackInput {
  id: string;
  description: string;
  skills: string[];
}

/** What a Scan ran with from its Skill Packs, recorded on the Scan. */
export interface PackSnapshot {
  id: string;
  skills: { name: string; description: string; hash: string }[];
}

/** Skill Packs (ADR-0008): named groups of Skill Library skills that callers add to Scans. */
@Injectable()
export class SkillPacks {
  constructor(
    @InjectRepository(SkillPack) private readonly packs: Repository<SkillPack>,
    @InjectRepository(LibrarySkill) private readonly skills: Repository<LibrarySkill>,
    private readonly library: SkillLibrary,
    private readonly clock: Clock,
  ) {}

  list(): Promise<SkillPack[]> {
    return this.packs.find({ order: { id: 'ASC' } });
  }

  async get(id: string): Promise<SkillPack> {
    const pack = await this.packs.findOneBy({ id });
    if (!pack) throw new NotFoundException(`Skill Pack ${id} not found`);
    return pack;
  }

  async create(input: SkillPackInput): Promise<SkillPack> {
    if (!PACK_ID_PATTERN.test(input.id)) throw new BadRequestException('Skill Pack id must be 1-64 lowercase letters, digits and dashes');
    if (await this.packs.existsBy({ id: input.id })) throw new ConflictException(`Skill Pack ${input.id} already exists`);
    const pack = this.packs.create({
      id: input.id,
      description: input.description?.trim() ?? '',
      skills: await this.checkSkills(input.skills),
      createdAt: this.clock.now().toISOString(),
    });
    await this.packs.insert(pack);
    return pack;
  }

  async update(id: string, change: { description?: string; skills?: string[] }): Promise<SkillPack> {
    const pack = await this.get(id);
    if (change.description !== undefined) pack.description = change.description.trim();
    if (change.skills !== undefined) pack.skills = await this.checkSkills(change.skills);
    await this.packs.save(pack);
    return pack;
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.packs.delete(id);
  }

  /** The packs named, in that order; 400 for any unknown. */
  async resolve(ids: string[]): Promise<SkillPack[]> {
    const unique = [...new Set(ids)];
    const found = await this.packs.findBy({ id: In(unique) });
    const missing = unique.filter((id) => !found.some((p) => p.id === id));
    if (missing.length) throw new BadRequestException(`Unknown Skill Pack(s): ${missing.join(', ')}. See GET /api/skill-packs`);
    return unique.map((id) => found.find((p) => p.id === id)!);
  }

  /**
   * Copies the profile's skills and the packs' skills into `target`, the one directory the
   * agent sees as /skills: later changes to the library or the packs do not reach this Scan.
   */
  async snapshot(packs: SkillPack[], profileSkillsDir: string | undefined, target: string): Promise<PackSnapshot[]> {
    await mkdir(target, { recursive: true });
    const fromProfile = new Set<string>();
    const taken = new Set<string>();
    if (profileSkillsDir) {
      for (const entry of await readdir(profileSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        await cp(join(profileSkillsDir, entry.name), join(target, entry.name), { recursive: true });
        fromProfile.add(entry.name);
        taken.add(entry.name);
      }
    }
    const rows = new Map((await this.skills.findBy({ name: In(packs.flatMap((p) => p.skills)) })).map((s) => [s.name, s]));
    const record: PackSnapshot[] = [];
    for (const pack of packs) {
      const skills: PackSnapshot['skills'] = [];
      for (const name of pack.skills) {
        const row = rows.get(name);
        if (!row) throw new ConflictException(`Skill Pack ${pack.id} names ${name}, which is no longer in the library`);
        // Refused at import, but a profile added since may bring a skill of the same name.
        if (fromProfile.has(name)) throw new ConflictException(`Skill Pack ${pack.id} has ${name}, which the Scan Profile brings too`);
        // Two packs may share a skill: copied once.
        if (!taken.has(name)) {
          await cp(this.library.dirOf(name), join(target, name), { recursive: true });
          taken.add(name);
        }
        skills.push({ name, description: row.description, hash: row.hash });
      }
      record.push({ id: pack.id, skills });
    }
    return record;
  }

  private async checkSkills(names: string[] | undefined): Promise<string[]> {
    const unique = [...new Set(names ?? [])];
    if (!unique.length) throw new BadRequestException('A Skill Pack needs at least one skill');
    const known = new Set((await this.skills.findBy({ name: In(unique) })).map((s) => s.name));
    const missing = unique.filter((n) => !known.has(n));
    if (missing.length) throw new BadRequestException(`Not in the Skill Library: ${missing.join(', ')}`);
    return unique;
  }
}
