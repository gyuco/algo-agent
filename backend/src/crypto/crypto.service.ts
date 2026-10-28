import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Encrypts secrets at rest as `iv.authTag.ciphertext` (base64url). An optional
 * `context` (authenticated, not stored) binds a ciphertext to where it belongs:
 * copied to another row, it no longer decrypts.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.getOrThrow<string>('ENCRYPTION_KEY'), 'hex');
    if (this.key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes in hex (64 chars)');
    }
  }

  encrypt(plaintext: string, context?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    if (context !== undefined) cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((b) => b.toString('base64url'))
      .join('.');
  }

  decrypt(payload: string, context?: string): string {
    const [iv, tag, ciphertext] = payload
      .split('.')
      .map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    if (context !== undefined) decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}
