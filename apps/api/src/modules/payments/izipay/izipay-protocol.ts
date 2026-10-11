import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Reglas del protocolo de Izipay (botón de pagos, developers.izipay.pe), sin efectos ni red:
 * firma, formato de montos y números de pedido. Ver docs/izipay/referencia.md.
 */

/** Firma de Izipay: HMAC-SHA256 del texto exacto de `payloadHttp` con la clave hash, en base64. */
export function izipaySignature(payloadHttp: string, hashKey: string): string {
  return createHmac('sha256', hashKey).update(payloadHttp, 'utf8').digest('base64');
}

/** Compara en tiempo constante. Una firma ausente o de otro largo es inválida. */
export function isValidIzipaySignature(
  payloadHttp: string,
  signature: unknown,
  hashKey: string,
): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const expected = Buffer.from(izipaySignature(payloadHttp, hashKey));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Céntimos → texto con 2 decimales y sin separador de miles ("25.00"). */
export function toIzipayAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('Monto inválido');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Texto de Izipay ("25.00", "25.5", "25") → céntimos. null si no es un monto válido. */
export function fromIzipayAmount(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}

/**
 * Número de pedido de Izipay (5–15 caracteres): derivado de la clave de idempotencia del pago,
 * así un reintento usa siempre el mismo pedido. 14 caracteres en base 36 (unos 72 bits).
 */
export function izipayOrderNumber(idempotencyKey: string): string {
  const hash = createHash('sha256').update(idempotencyKey).digest();
  const value = hash.readBigUInt64BE(0) ^ (BigInt(hash.readUInt32BE(8)) << 32n);
  return `C${value.toString(36).toUpperCase().padStart(14, '0').slice(-14)}`;
}

/** Código de Izipay de una operación aprobada. */
export const IZIPAY_SUCCESS = '00';

/** Códigos sin firma (la documentación pide no validarla en estos casos). */
export const IZIPAY_UNSIGNED_CODES = new Set(['021', 'COMMUNICATION_ERROR']);

/** Datos firmados de una respuesta o notificación (el contenido de `payloadHttp`). */
export interface IzipaySignedPayload {
  code?: string;
  message?: string;
  transactionId?: string;
  response?: {
    payMethod?: string;
    order?: {
      payMethodAuthorization?: string;
      codeAuth?: string;
      currency?: string;
      amount?: string;
      orderNumber?: string;
      stateMessage?: string;
      uniqueId?: string;
      referenceNumber?: string;
      dateTransaction?: string;
      timeTransaction?: string;
    }[];
  };
}

/** Respuesta o aviso de Izipay con firma: `{ …, payloadHttp, signature }`. */
export interface IzipaySignedEnvelope {
  code?: string;
  payloadHttp?: string;
  signature?: string;
  transactionId?: string;
}

/**
 * Verifica y abre un sobre firmado. Devuelve los datos **firmados** (nunca los del resto del
 * cuerpo, que no están protegidos), o null si la firma no es válida.
 */
export function openSignedEnvelope(
  envelope: IzipaySignedEnvelope,
  hashKey: string,
): IzipaySignedPayload | null {
  if (typeof envelope.payloadHttp !== 'string') return null;
  if (!isValidIzipaySignature(envelope.payloadHttp, envelope.signature, hashKey)) return null;
  try {
    const parsed: unknown = JSON.parse(envelope.payloadHttp);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
