import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Cadence } from '../schedule-timing';

/** Scans of a Saved Repository the server starts by itself, at the times it says (ADR-0014). */
@Entity('schedules')
export class ScanSchedule {
  /** Also the start of the ids of the Scans it starts. */
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  description: string;

  /** The Saved Repository it scans. */
  @Column({ type: 'text' })
  repository: string;

  /** Over the repository's own ref; null: the repository's. */
  @Column({ type: 'text', nullable: true })
  ref: string | null;

  @Column({ type: 'text' })
  profile: string;

  /** Null: the Default Model when the Scan starts. */
  @Column({ type: 'text', nullable: true })
  model: string | null;

  /** Null: the server default. */
  @Column({ type: 'text', nullable: true })
  language: string | null;

  @Column({ type: 'text', nullable: true })
  instructions: string | null;

  @Column({ type: 'simple-json', nullable: true })
  skillPacks: string[] | null;

  @Column({ type: 'integer', nullable: true })
  attemptTimeoutMinutes: number | null;

  @Column({ type: 'text' })
  cadence: Cadence;

  /** With cadence `interval`. */
  @Column({ type: 'integer', nullable: true })
  intervalHours: number | null;

  /** `HH:MM` in `timeZone`, with cadence `daily` or `weekly`. */
  @Column({ type: 'text', nullable: true })
  time: string | null;

  /** 0 (Sunday) to 6, with cadence `weekly`. */
  @Column({ type: 'simple-json', nullable: true })
  weekdays: number[] | null;

  /** IANA time zone `time` is in, e.g. `Europe/Rome`. */
  @Column({ type: 'text' })
  timeZone: string;

  @Column({ type: 'boolean' })
  enabled: boolean;

  /** When it starts its next Scan (ISO-8601); null while disabled. */
  @Column({ type: 'text', nullable: true })
  nextRunAt: string | null;

  @Column({ type: 'text', nullable: true })
  lastRunAt: string | null;

  /** The last Scan it started; it may since have been deleted or expired. */
  @Column({ type: 'text', nullable: true })
  lastScanId: string | null;

  /** Why its last run started no Scan; null when it did. */
  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'text' })
  createdAt: string;
}
