import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * Encrypts Provider API keys at rest with AES-256-GCM (ADR-0006). The key derives from
 * SCANNER_SECRET_KEY; each value gets its own IV, and is bound to the row it belongs to (`aad`),
 * so a ciphertext copied to another Provider does not decrypt.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }

  seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  /** Throws when the value was sealed with another secret, for another row, or was altered. */
  open(sealed: string, aad: string): string {
    const [version, payload] = sealed.split('.', 2);
    if (version !== VERSION || !payload) throw new Error('unknown format');
    const raw = Buffer.from(payload, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}
