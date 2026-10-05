import { randomBytes } from 'node:crypto';

/** Claves aleatorias para pruebas: nunca se escriben claves fijas en el código. */
export function randomKey(): string {
  return randomBytes(32).toString('base64');
}

export function randomCryptoEnv(): Record<string, string> {
  return {
    FIELD_ENCRYPTION_KEYS: `1:${randomKey()}`,
    FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
    BLIND_INDEX_KEY: randomKey(),
  };
}
