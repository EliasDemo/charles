import {
  base32Decode,
  base32Encode,
  newTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from './totp';

/** Secreto del RFC 6238 (Apéndice B): "12345678901234567890" en ASCII. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('base32 ida y vuelta', () => {
    const data = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(base32Decode(base32Encode(data))).toEqual(data);
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe(
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    );
    expect(base32Decode('gezd gnbv')).toEqual(base32Decode('GEZDGNBV'));
    expect(() => base32Decode('0189')).toThrow();
  });

  it('coincide con los vectores del RFC (SHA-1, 6 últimos dígitos)', () => {
    // RFC 6238, Apéndice B: códigos de 8 dígitos; los 6 últimos son los de 6 dígitos.
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ];
    for (const [seconds, code8] of vectors) {
      expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code8.slice(-6));
    }
  });

  it('acepta ±1 paso, rechaza otros y nunca el mismo paso dos veces', () => {
    const now = 1_900_000_000_000;
    const step = totpStep(now);
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(verifyTotp(secret, totpCode(secret, step), now, null)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now, null)).toBeNull();
    // Reutilización: el paso ya usado (o anterior) no vale.
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now, null)).toBeNull();
    expect(verifyTotp(secret, '12345', now, null)).toBeNull();
  });

  it('URI para el código QR', () => {
    const uri = otpauthUri('ABC', 'soporte@example.com');
    expect(uri).toBe(
      'otpauth://totp/Charles%3Asoporte%40example.com?secret=ABC&issuer=Charles&algorithm=SHA1&digits=6&period=30',
    );
  });
});
