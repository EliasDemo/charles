import { createHmac } from 'node:crypto';
import { refundStatusOf } from './izipay-gateway';
import {
  fromIzipayAmount,
  isValidIzipaySignature,
  izipayOrderNumber,
  izipaySignature,
  openSignedEnvelope,
  toIzipayAmount,
} from './izipay-protocol';

describe('Protocolo de Izipay', () => {
  const key = 'clave-hash-de-prueba';
  const payloadHttp = JSON.stringify({
    code: '00',
    transactionId: '17370678303660',
    response: { order: [{ orderNumber: 'C00000000000001', amount: '149.00', currency: 'PEN' }] },
  });

  it('firma: HMAC-SHA256 del texto exacto de payloadHttp, en base64 (como la documentación)', () => {
    const expected = createHmac('sha256', key).update(payloadHttp).digest('base64');
    expect(izipaySignature(payloadHttp, key)).toBe(expected);
    expect(isValidIzipaySignature(payloadHttp, expected, key)).toBe(true);
    expect(isValidIzipaySignature(`${payloadHttp} `, expected, key)).toBe(false);
    expect(isValidIzipaySignature(payloadHttp, expected, 'otra-clave')).toBe(false);
    expect(isValidIzipaySignature(payloadHttp, '', key)).toBe(false);
    expect(isValidIzipaySignature(payloadHttp, undefined, key)).toBe(false);
  });

  it('solo abre sobres con firma válida y devuelve los datos firmados', () => {
    const signature = izipaySignature(payloadHttp, key);
    expect(openSignedEnvelope({ payloadHttp, signature }, key)?.response?.order?.[0]?.amount).toBe(
      '149.00',
    );
    expect(openSignedEnvelope({ payloadHttp, signature: 'x' }, key)).toBeNull();
    expect(openSignedEnvelope({ signature }, key)).toBeNull();
    const notJson = 'no es json';
    expect(
      openSignedEnvelope({ payloadHttp: notJson, signature: izipaySignature(notJson, key) }, key),
    ).toBeNull();
  });

  it('montos: céntimos ↔ texto con dos decimales', () => {
    expect(toIzipayAmount(2500)).toBe('25.00');
    expect(toIzipayAmount(5)).toBe('0.05');
    expect(toIzipayAmount(123456)).toBe('1234.56');
    expect(() => toIzipayAmount(-1)).toThrow();
    expect(() => toIzipayAmount(1.5)).toThrow();
    expect(fromIzipayAmount('25.00')).toBe(2500);
    expect(fromIzipayAmount('25.5')).toBe(2550);
    expect(fromIzipayAmount('25')).toBe(2500);
    expect(fromIzipayAmount('1,000.00')).toBeNull();
    expect(fromIzipayAmount('-1.00')).toBeNull();
    expect(fromIzipayAmount(25)).toBeNull();
  });

  it('número de pedido: 15 caracteres, estable por clave y distinto entre claves', () => {
    const a = izipayOrderNumber('booking:a');
    expect(a).toMatch(/^C[0-9A-Z]{14}$/);
    expect(izipayOrderNumber('booking:a')).toBe(a);
    const many = new Set(Array.from({ length: 2000 }, (_, i) => izipayOrderNumber(`booking:${i}`)));
    expect(many.size).toBe(2000);
  });

  it('estado de devolución por nombre; lo desconocido sigue pendiente', () => {
    expect(refundStatusOf('AUTORIZADO')).toBe('SUCCEEDED');
    expect(refundStatusOf('Rechazado')).toBe('FAILED');
    expect(refundStatusOf('EN PROCESO')).toBe('PENDING');
    expect(refundStatusOf(null)).toBe('PENDING');
  });
});
