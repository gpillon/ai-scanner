import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { PackSnapshot } from '../../skills/skill-packs.service';

export interface ScanSource {
  type: 'git';
  /** Never with credentials. */
  url: string;
  /** As the caller asked; null for the default branch. */
  ref: string | null;
  commit: string;
}

/** `warming`: waiting for the model to answer, before the first Attempt (ADR-0009). */
export type ScanState = 'queued' | 'warming' | 'running' | 'succeeded' | 'failed';

/** Timestamps are ISO-8601 strings so they sort and compare lexicographically. */
@Entity('scans')
export class Scan {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  state: ScanState;

  @Column({ type: 'text' })
  profile: string;

  @Column({ type: 'text' })
  model: string;

  @Column({ type: 'text' })
  language: string;

  @Column({ type: 'text', nullable: true })
  instructions: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'text' })
  createdAt: string;

  @Column({ type: 'text', nullable: true })
  startedAt: string | null;

  @Column({ type: 'text', nullable: true })
  finishedAt: string | null;

  @Column({ type: 'text', nullable: true })
  failureReason: string | null;

  /** Where the code came from when not a zip: a Git repository, without credentials (ADR-0010). */
  @Column({ type: 'simple-json', nullable: true })
  source: ScanSource | null;

  /** The Skill Packs the caller added, with the skills copied for this Scan (ADR-0008). */
  @Column({ type: 'simple-json', nullable: true })
  skillPacks: PackSnapshot[] | null;
}
