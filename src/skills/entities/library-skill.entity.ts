import { Column, Entity, PrimaryColumn } from 'typeorm';

/** A skill the admin imported into the Skill Library (ADR-0008); its files are under `paths.skills`. */
@Entity('library_skills')
export class LibrarySkill {
  /** From its SKILL.md; also its directory name. */
  @PrimaryColumn({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  description: string;

  /** Where it came from: `upload:<file>` or the `skills add` source. */
  @Column({ type: 'text' })
  source: string;

  /** sha256 of its files, to tell versions apart. */
  @Column({ type: 'text' })
  hash: string;

  @Column({ type: 'integer' })
  files: number;

  @Column({ type: 'integer' })
  bytes: number;

  @Column({ type: 'text' })
  importedAt: string;
}
