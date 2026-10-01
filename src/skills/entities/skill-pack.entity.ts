import { Column, Entity, PrimaryColumn } from 'typeorm';

/** A named group of Skill Library skills a caller can add to a Scan (ADR-0008). */
@Entity('skill_packs')
export class SkillPack {
  /** What callers pass in `skillPacks`. */
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  description: string;

  /** Skill Library names. */
  @Column({ type: 'simple-json' })
  skills: string[];

  @Column({ type: 'text' })
  createdAt: string;
}
