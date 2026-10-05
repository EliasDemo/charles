import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { BLIND_INDEX_NORMALIZERS } from './blind-index.normalizers';
import type { BlindIndexKind, EncryptedField, OneTimeCodePurpose } from './encryption-contexts';
import { KEY_PROVIDER, type KeyProvider } from './key-provider';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;
const STORED_FORMAT =
  /^v([1-9]\d{0,3}):([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]*={0,2})$/;
/** Separa los componentes de cada HMAC (no puede aparecer en los valores normalizados). */
const SEPARATOR = '\u0000';

/** Error genérico de descifrado: no revela si falló la clave, la etiqueta o el formato. */
export class DecryptionError extends Error {
  constructor() {
    super('No se pudo descifrar el valor');
    this.name = 'DecryptionError';
  }
}

interface ParsedValue {
  version: number;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/**
 * Cifrado de campos con AES-256-GCM e índices ciegos con HMAC-SHA256 (CLAUDE.md §6.2).
 *
 * - Formato almacenado: `v{versión}:{iv}:{tag}:{cifrado}` (base64), para rotar claves.
 * - IV aleatorio de 12 bytes por valor y etiqueta de autenticación de 16 bytes.
 * - AAD = contexto estable del campo (`EncryptedField`): un valor cifrado no puede
 *   copiarse a otro campo sin que el descifrado falle.
 */
@Injectable()
export class EncryptionService {
  constructor(@Inject(KEY_PROVIDER) private readonly keys: KeyProvider) {}

  encrypt(plaintext: string, field: EncryptedField): string {
    const version = this.keys.activeKeyVersion();
    const key = this.keys.encryptionKey(version);
    if (!key) throw new Error('La clave de cifrado activa no está disponible');

    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH_BYTES });
    cipher.setAAD(Buffer.from(field, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `v${version}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  decrypt(stored: string, field: EncryptedField): string {
    const parsed = this.parse(stored);
    const key = parsed ? this.keys.encryptionKey(parsed.version) : undefined;
    if (!parsed || !key) throw new DecryptionError();

    try {
      const decipher = createDecipheriv(ALGORITHM, key, parsed.iv, {
        authTagLength: TAG_LENGTH_BYTES,
      });
      decipher.setAAD(Buffer.from(field, 'utf8'));
      decipher.setAuthTag(parsed.tag);
      return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new DecryptionError();
    }
  }

  encryptNullable(plaintext: string | null | undefined, field: EncryptedField): string | null {
    return plaintext == null ? null : this.encrypt(plaintext, field);
  }

  decryptNullable(stored: string | null | undefined, field: EncryptedField): string | null {
    return stored == null ? null : this.decrypt(stored, field);
  }

  /** `true` si el valor se cifró con una versión distinta de la activa (rotación pendiente). */
  needsReencryption(stored: string): boolean {
    const parsed = this.parse(stored);
    if (!parsed) throw new DecryptionError();
    return parsed.version !== this.keys.activeKeyVersion();
  }

  /** Vuelve a cifrar con la clave activa (para el proceso de rotación). */
  reencrypt(stored: string, field: EncryptedField): string {
    return this.encrypt(this.decrypt(stored, field), field);
  }

  /**
   * Índice ciego: HMAC-SHA256(separador de dominio ‖ valor normalizado, clave de índice).
   * Determinista: permite buscar e imponer unicidad sin descifrar.
   */
  blindIndex(value: string, kind: BlindIndexKind): Buffer<ArrayBuffer> {
    return this.hmac(kind, BLIND_INDEX_NORMALIZERS[kind](value));
  }

  blindIndexNullable(
    value: string | null | undefined,
    kind: BlindIndexKind,
  ): Buffer<ArrayBuffer> | null {
    return value == null ? null : this.blindIndex(value, kind);
  }

  /**
   * HMAC de un código de un solo uso, ligado a su propósito y a su usuario: un código de
   * recuperación no sirve como código de verificación ni para otra cuenta. Un código de 6 dígitos
   * es adivinable sin clave; por eso se usa HMAC (no un hash simple) y un límite de intentos.
   */
  oneTimeCodeHash(code: string, purpose: OneTimeCodePurpose, userId: string): Buffer<ArrayBuffer> {
    return this.hmac(purpose, userId, code);
  }

  private hmac(domain: string, ...parts: string[]): Buffer<ArrayBuffer> {
    const mac = createHmac('sha256', this.keys.blindIndexKey()).update(domain, 'utf8');
    for (const part of parts) mac.update(SEPARATOR).update(part, 'utf8');
    // Copia con ArrayBuffer propio: es el tipo que Prisma espera para columnas Bytes.
    return Buffer.from(mac.digest());
  }

  private parse(stored: string): ParsedValue | undefined {
    const match = STORED_FORMAT.exec(stored);
    if (!match) return undefined;
    const [, version, iv, tag, ciphertext] = match;
    const parsed = {
      version: Number(version),
      iv: Buffer.from(iv!, 'base64'),
      tag: Buffer.from(tag!, 'base64'),
      ciphertext: Buffer.from(ciphertext!, 'base64'),
    };
    if (parsed.iv.length !== IV_LENGTH_BYTES || parsed.tag.length !== TAG_LENGTH_BYTES) {
      return undefined;
    }
    return parsed;
  }
}
