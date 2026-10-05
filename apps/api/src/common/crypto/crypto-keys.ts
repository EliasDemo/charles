import { timingSafeEqual } from 'node:crypto';

/** AES-256 y HMAC-SHA256 usan claves de 32 bytes. */
export const KEY_LENGTH_BYTES = 32;

export interface CryptoKeys {
  /** Claves de cifrado por versión (rotación). */
  encryptionKeys: ReadonlyMap<number, Buffer>;
  /** Versión con la que se cifran los valores nuevos. */
  activeKeyVersion: number;
  /** Clave del índice ciego; siempre distinta de las de cifrado. */
  blindIndexKey: Buffer;
}

export interface RawCryptoEnv {
  FIELD_ENCRYPTION_KEYS?: unknown;
  FIELD_ENCRYPTION_ACTIVE_KEY_VERSION?: unknown;
  BLIND_INDEX_KEY?: unknown;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeKey(value: string): Buffer | undefined {
  if (!BASE64.test(value)) return undefined;
  const key = Buffer.from(value, 'base64');
  return key.length === KEY_LENGTH_BYTES ? key : undefined;
}

function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Interpreta y valida las claves (CLAUDE.md §6.2). Formato:
 * - FIELD_ENCRYPTION_KEYS="1:<base64 32 bytes>,2:<base64 32 bytes>"
 * - FIELD_ENCRYPTION_ACTIVE_KEY_VERSION=2
 * - BLIND_INDEX_KEY=<base64 32 bytes>
 * Los mensajes de error nunca incluyen el valor de las claves.
 */
export function parseCryptoKeys(env: RawCryptoEnv): { value?: CryptoKeys; errors: string[] } {
  const errors: string[] = [];
  const encryptionKeys = new Map<number, Buffer>();

  if (typeof env.FIELD_ENCRYPTION_KEYS !== 'string' || env.FIELD_ENCRYPTION_KEYS.trim() === '') {
    errors.push('FIELD_ENCRYPTION_KEYS: es obligatoria');
  } else {
    for (const entry of env.FIELD_ENCRYPTION_KEYS.split(',').map((s) => s.trim())) {
      const separator = entry.indexOf(':');
      const version = entry.slice(0, separator);
      const key = separator > 0 ? decodeKey(entry.slice(separator + 1)) : undefined;
      if (!/^[1-9]\d{0,3}$/.test(version) || !key) {
        errors.push(
          `FIELD_ENCRYPTION_KEYS: cada entrada debe ser <versión>:<base64 de ${KEY_LENGTH_BYTES} bytes>`,
        );
        continue;
      }
      if (encryptionKeys.has(Number(version))) {
        errors.push(`FIELD_ENCRYPTION_KEYS: versión ${version} repetida`);
        continue;
      }
      encryptionKeys.set(Number(version), key);
    }
  }

  const rawActive = env.FIELD_ENCRYPTION_ACTIVE_KEY_VERSION;
  const activeKeyVersion =
    typeof rawActive === 'string' && /^[1-9]\d{0,3}$/.test(rawActive) ? Number(rawActive) : NaN;
  if (Number.isNaN(activeKeyVersion)) {
    errors.push('FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: debe ser un entero positivo');
  } else if (encryptionKeys.size > 0 && !encryptionKeys.has(activeKeyVersion)) {
    errors.push('FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: no existe en FIELD_ENCRYPTION_KEYS');
  }

  const blindIndexKey =
    typeof env.BLIND_INDEX_KEY === 'string' ? decodeKey(env.BLIND_INDEX_KEY.trim()) : undefined;
  if (!blindIndexKey) {
    errors.push(`BLIND_INDEX_KEY: debe ser base64 de ${KEY_LENGTH_BYTES} bytes`);
  }

  const keys = [...encryptionKeys.values()];
  if (keys.some((k, i) => keys.slice(i + 1).some((other) => sameKey(k, other)))) {
    errors.push('FIELD_ENCRYPTION_KEYS: las claves de distintas versiones deben ser distintas');
  }
  if (blindIndexKey && keys.some((k) => sameKey(k, blindIndexKey))) {
    errors.push('BLIND_INDEX_KEY: debe ser distinta de las claves de cifrado');
  }

  if (errors.length > 0 || !blindIndexKey) return { errors };
  return { value: { encryptionKeys, activeKeyVersion, blindIndexKey }, errors };
}
