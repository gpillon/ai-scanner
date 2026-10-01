import { Column, Entity, PrimaryColumn } from 'typeorm';

/** A Source Repository kept on the server under a name, for Scans and Scan Schedules to use (ADR-0014). */
@Entity('repositories')
export class SavedRepository {
  /** What Scans and Scan Schedules pass in `repository`. */
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  description: string;

  /** Never with credentials. */
  @Column({ type: 'text' })
  url: string;

  /** The branch or tag Scans check out unless they say otherwise; null for the default branch. */
  @Column({ type: 'text', nullable: true })
  ref: string | null;

  /** For a private repository; null: `oauth2`, as with a token given per Scan. */
  @Column({ type: 'text', nullable: true })
  username: string | null;

  /** The token, sealed with SCANNER_SECRET_KEY (see SecretBox); never sent back. */
  @Column({ type: 'text', nullable: true })
  tokenSealed: string | null;

  /** The token's last characters, so the caller can tell which one is set. */
  @Column({ type: 'text', nullable: true })
  tokenHint: string | null;

  @Column({ type: 'text' })
  createdAt: string;
}
