import type { CryptoKeys } from './crypto-keys';

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

/**
 * Origen de las claves. Hoy vienen de variables de entorno (inyectadas desde el gestor
 * de secretos); mañana puede ser un KMS sin cambiar `EncryptionService`.
 */
export interface KeyProvider {
  activeKeyVersion(): number;
  /** `undefined` si la versión no existe (por ejemplo, una clave retirada). */
  encryptionKey(version: number): Buffer | undefined;
  blindIndexKey(): Buffer;
}

export class StaticKeyProvider implements KeyProvider {
  constructor(private readonly keys: CryptoKeys) {}

  activeKeyVersion(): number {
    return this.keys.activeKeyVersion;
  }

  encryptionKey(version: number): Buffer | undefined {
    return this.keys.encryptionKeys.get(version);
  }

  blindIndexKey(): Buffer {
    return this.keys.blindIndexKey;
  }
}
