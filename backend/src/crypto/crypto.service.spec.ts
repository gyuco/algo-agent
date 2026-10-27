import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service.js';

describe('CryptoService', () => {
  const key = 'a'.repeat(64);
  const service = new CryptoService(new ConfigService({ ENCRYPTION_KEY: key }));

  it('round-trips a secret', () => {
    const encrypted = service.encrypt('sk-ant-secret');
    expect(encrypted).not.toContain('sk-ant-secret');
    expect(service.decrypt(encrypted)).toBe('sk-ant-secret');
  });

  it('rejects tampered ciphertext', () => {
    const [iv, tag, data] = service.encrypt('sk-ant-secret').split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 1;
    expect(() =>
      service.decrypt([iv, tag, flipped.toString('base64url')].join('.')),
    ).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(
      () => new CryptoService(new ConfigService({ ENCRYPTION_KEY: 'abcd' })),
    ).toThrow();
  });
});
