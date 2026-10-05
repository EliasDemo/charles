import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

export interface JwtKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/**
 * Interpreta JWT_PRIVATE_KEY: clave privada EC P-256 (ES256) en PEM PKCS#8, codificada en base64
 * para caber en una sola línea. La clave pública se deriva de ella.
 * El mensaje de error nunca incluye el valor de la clave.
 */
export function parseJwtPrivateKey(raw: unknown): { value?: JwtKeys; errors: string[] } {
  const error = {
    errors: [
      'JWT_PRIVATE_KEY: debe ser una clave privada EC P-256 (PEM PKCS#8) codificada en base64',
    ],
  };
  if (typeof raw !== 'string' || raw.trim() === '') return error;
  try {
    const pem = Buffer.from(raw.trim(), 'base64').toString('utf8');
    const privateKey = createPrivateKey({ key: pem, format: 'pem' });
    if (
      privateKey.asymmetricKeyType !== 'ec' ||
      privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      return error;
    }
    return { value: { privateKey, publicKey: createPublicKey(privateKey) }, errors: [] };
  } catch {
    return error;
  }
}
