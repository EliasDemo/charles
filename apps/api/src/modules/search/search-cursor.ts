import { HttpStatus, Injectable } from '@nestjs/common';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { SearchSort } from './ranking/ranking';

interface CursorPayload {
  v: 1;
  sort: SearchSort;
  values: (number | string)[];
}

const invalidCursor = (): AppException =>
  new AppException(
    ErrorCode.INVALID_CURSOR,
    'El cursor no es válido para esta búsqueda. Vuelve a buscar desde la primera página.',
    HttpStatus.BAD_REQUEST,
  );

/**
 * Cursor opaco de la búsqueda: la clave de orden del último elemento, cifrada y autenticada
 * (AES-256-GCM). Así no se puede manipular ni revela la distancia del cliente a una barbería
 * (la URL puede quedar en logs de terceros).
 */
@Injectable()
export class SearchCursor {
  constructor(private readonly encryption: EncryptionService) {}

  encode(sort: SearchSort, values: (number | string)[]): string {
    const payload: CursorPayload = { v: 1, sort, values };
    const sealed = this.encryption.encrypt(JSON.stringify(payload), EncryptedField.SEARCH_CURSOR);
    return Buffer.from(sealed, 'utf8').toString('base64url');
  }

  /** Valores del cursor; 400 si fue alterado o pertenece a otro orden o cantidad de claves. */
  decode(cursor: string, sort: SearchSort, keyCount: number): (number | string)[] {
    let payload: unknown;
    try {
      const sealed = Buffer.from(cursor, 'base64url').toString('utf8');
      payload = JSON.parse(this.encryption.decrypt(sealed, EncryptedField.SEARCH_CURSOR));
    } catch {
      throw invalidCursor();
    }
    if (!isPayload(payload) || payload.sort !== sort || payload.values.length !== keyCount) {
      throw invalidCursor();
    }
    return payload.values;
  }
}

function isPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.sort === 'string' &&
    Array.isArray(p.values) &&
    p.values.every((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))
  );
}
