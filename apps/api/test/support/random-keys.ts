import { generateKeyPairSync, randomBytes } from 'node:crypto';

/** Claves aleatorias para pruebas: nunca se escriben claves fijas en el código. */
export function randomKey(): string {
  return randomBytes(32).toString('base64');
}

export function randomCryptoEnv(): Record<string, string> {
  return {
    FIELD_ENCRYPTION_KEYS: `1:${randomKey()}`,
    FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
    BLIND_INDEX_KEY: randomKey(),
    JWT_PRIVATE_KEY: randomJwtPrivateKey(),
  };
}

/** Clave privada ES256 (P-256) efímera, en PEM PKCS#8 codificado en base64. */
export function randomJwtPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
}
