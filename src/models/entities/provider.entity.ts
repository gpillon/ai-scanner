import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { ProviderKind } from '../provider-kinds';

/** An LLM API the Model Pool's models are served by, with how to reach and pay for it. */
@Entity('providers')
export class Provider {
  /** Chosen by the admin. For `openai-compatible`, it is also the provider name opencode sees. */
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  kind: ProviderKind;

  /** Overrides the kind's default; required for `openai-compatible`. */
  @Column({ type: 'text', nullable: true })
  baseUrl: string | null;

  /** The API key, sealed with SCANNER_SECRET_KEY (see SecretBox); never sent back. */
  @Column({ type: 'text', nullable: true })
  apiKeySealed: string | null;

  /** The key's last characters, so the admin can tell which one is set. */
  @Column({ type: 'text', nullable: true })
  apiKeyHint: string | null;

  /** Or a server environment variable holding the key, as SCANNER_MODELS gave it. */
  @Column({ type: 'text', nullable: true })
  apiKeyEnv: string | null;

  @Column({ type: 'text' })
  createdAt: string;
}
