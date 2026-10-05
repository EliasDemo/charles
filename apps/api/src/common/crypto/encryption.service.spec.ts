import { randomBytes } from 'node:crypto';
import { parseCryptoKeys } from './crypto-keys';
import { BlindIndexKind, EncryptedField } from './encryption-contexts';
import { DecryptionError, EncryptionService } from './encryption.service';
import { StaticKeyProvider } from './key-provider';

const key = (): Buffer => randomBytes(32);

function serviceWith(keys: Record<number, Buffer>, active: number, blindIndexKey = key()) {
  return new EncryptionService(
    new StaticKeyProvider({
      encryptionKeys: new Map(Object.entries(keys).map(([v, k]) => [Number(v), k])),
      activeKeyVersion: active,
      blindIndexKey,
    }),
  );
}

/** Altera un segmento base64 del valor almacenado (0=versión, 1=iv, 2=tag, 3=cifrado). */
function tamper(stored: string, segment: 1 | 2 | 3): string {
  const parts = stored.split(':');
  const bytes = Buffer.from(parts[segment]!, 'base64');
  bytes[0] = bytes[0]! ^ 0xff;
  parts[segment] = bytes.toString('base64');
  return parts.join(':');
}

describe('EncryptionService — cifrado de campos', () => {
  const k1 = key();
  const service = serviceWith({ 1: k1 }, 1);

  it('cifra y descifra (ida y vuelta), incluidos acentos y emojis', () => {
    for (const value of ['persona@example.com', 'Ñandú Pérez 💈', '']) {
      const stored = service.encrypt(value, EncryptedField.USER_EMAIL);
      expect(service.decrypt(stored, EncryptedField.USER_EMAIL)).toBe(value);
    }
  });

  it('usa el formato v{versión}:{iv}:{tag}:{cifrado} en base64', () => {
    const stored = service.encrypt('dato', EncryptedField.USER_PHONE);
    expect(stored).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/);
    const [, iv, tag] = stored.split(':');
    expect(Buffer.from(iv!, 'base64')).toHaveLength(12);
    expect(Buffer.from(tag!, 'base64')).toHaveLength(16);
  });

  it('usa un IV aleatorio: el mismo valor produce cifrados distintos', () => {
    const a = service.encrypt('mismo', EncryptedField.USER_EMAIL);
    const b = service.encrypt('mismo', EncryptedField.USER_EMAIL);
    expect(a).not.toBe(b);
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });

  it('no contiene el texto en claro', () => {
    const stored = service.encrypt('persona@example.com', EncryptedField.USER_EMAIL);
    expect(stored).not.toContain('persona');
    expect(Buffer.from(stored.split(':')[3]!, 'base64').toString('utf8')).not.toContain('persona');
  });

  it.each([1, 2, 3] as const)('rechaza un valor alterado (segmento %i)', (segment) => {
    const stored = service.encrypt('dato', EncryptedField.USER_EMAIL);
    expect(() => service.decrypt(tamper(stored, segment), EncryptedField.USER_EMAIL)).toThrow(
      DecryptionError,
    );
  });

  it('rechaza descifrar con otro contexto (AAD): no se puede mover un valor de campo', () => {
    const stored = service.encrypt('dato', EncryptedField.USER_EMAIL);
    expect(() => service.decrypt(stored, EncryptedField.USER_PHONE)).toThrow(DecryptionError);
  });

  it('rechaza una clave incorrecta', () => {
    const stored = service.encrypt('dato', EncryptedField.USER_EMAIL);
    const other = serviceWith({ 1: key() }, 1);
    expect(() => other.decrypt(stored, EncryptedField.USER_EMAIL)).toThrow(DecryptionError);
  });

  it.each([
    '',
    'texto-plano',
    'v1:abc',
    'v0:a:b:c',
    'v1:AAAA:AAAA:AAAA',
    'v9:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AA==',
  ])('rechaza un formato inválido o versión desconocida: %p', (stored) => {
    expect(() => service.decrypt(stored, EncryptedField.USER_EMAIL)).toThrow(DecryptionError);
  });

  it('el error de descifrado no revela detalles', () => {
    const stored = service.encrypt('secreto', EncryptedField.USER_EMAIL);
    expect(() => service.decrypt(stored, EncryptedField.USER_PHONE)).toThrow(
      'No se pudo descifrar el valor',
    );
  });

  it('maneja valores nulos', () => {
    expect(service.encryptNullable(null, EncryptedField.USER_PHONE)).toBeNull();
    expect(service.decryptNullable(undefined, EncryptedField.USER_PHONE)).toBeNull();
    const stored = service.encryptNullable('x', EncryptedField.USER_PHONE)!;
    expect(service.decryptNullable(stored, EncryptedField.USER_PHONE)).toBe('x');
  });

  it('los contextos son constantes estables y únicos', () => {
    const contexts = Object.values(EncryptedField);
    expect(new Set(contexts).size).toBe(contexts.length);
    expect(EncryptedField.USER_EMAIL).toBe('charles/user.email/v1');
    for (const context of contexts) expect(context).toMatch(/^charles\/[a-z.-]+\/v\d+$/);
  });
});

describe('EncryptionService — rotación de claves', () => {
  const k1 = key();
  const k2 = key();

  it('descifra valores de una versión anterior y cifra con la activa', () => {
    const old = serviceWith({ 1: k1 }, 1).encrypt('dato', EncryptedField.BARBER_PHONE);
    const rotated = serviceWith({ 1: k1, 2: k2 }, 2);

    expect(rotated.decrypt(old, EncryptedField.BARBER_PHONE)).toBe('dato');
    expect(rotated.needsReencryption(old)).toBe(true);

    const fresh = rotated.reencrypt(old, EncryptedField.BARBER_PHONE);
    expect(fresh.startsWith('v2:')).toBe(true);
    expect(rotated.needsReencryption(fresh)).toBe(false);
    expect(rotated.decrypt(fresh, EncryptedField.BARBER_PHONE)).toBe('dato');
  });

  it('falla de forma controlada si se retiró la clave de una versión', () => {
    const old = serviceWith({ 1: k1 }, 1).encrypt('dato', EncryptedField.BARBER_PHONE);
    const withoutV1 = serviceWith({ 2: k2 }, 2);
    expect(() => withoutV1.decrypt(old, EncryptedField.BARBER_PHONE)).toThrow(DecryptionError);
  });
});

describe('EncryptionService — índice ciego', () => {
  const indexKey = key();
  const service = serviceWith({ 1: key() }, 1, indexKey);

  it('es determinista y de 32 bytes', () => {
    const a = service.blindIndex('persona@example.com', BlindIndexKind.EMAIL);
    expect(a).toHaveLength(32);
    expect(a.equals(service.blindIndex('persona@example.com', BlindIndexKind.EMAIL))).toBe(true);
  });

  it('no depende de la clave de cifrado activa (rotarla no cambia los hashes)', () => {
    const rotated = serviceWith({ 1: key(), 2: key() }, 2, indexKey);
    expect(
      rotated
        .blindIndex('persona@example.com', BlindIndexKind.EMAIL)
        .equals(service.blindIndex('persona@example.com', BlindIndexKind.EMAIL)),
    ).toBe(true);
  });

  it.each([
    [BlindIndexKind.EMAIL, '  Persona@Example.COM ', 'persona@example.com'],
    [BlindIndexKind.PHONE, '+51 987-654-321', '+51987654321'],
    [BlindIndexKind.PHONE, '(01) 234 5678', '012345678'],
    [BlindIndexKind.DOCUMENT, 'ab-123 45', 'AB12345'],
    [BlindIndexKind.DOCUMENT, '12.345.678', '12345678'],
  ])('normaliza %s: %p ≡ %p', (kind, a, b) => {
    expect(service.blindIndex(a, kind).equals(service.blindIndex(b, kind))).toBe(true);
  });

  it('separa dominios: el mismo texto en distinto tipo produce otro hash', () => {
    expect(
      service
        .blindIndex('12345678', BlindIndexKind.PHONE)
        .equals(service.blindIndex('12345678', BlindIndexKind.DOCUMENT)),
    ).toBe(false);
  });

  it('cambia si cambia la clave de índice', () => {
    const other = serviceWith({ 1: key() }, 1, key());
    expect(
      other
        .blindIndex('persona@example.com', BlindIndexKind.EMAIL)
        .equals(service.blindIndex('persona@example.com', BlindIndexKind.EMAIL)),
    ).toBe(false);
  });

  it('maneja valores nulos', () => {
    expect(service.blindIndexNullable(null, BlindIndexKind.PHONE)).toBeNull();
  });
});

describe('parseCryptoKeys', () => {
  const b64 = (): string => key().toString('base64');

  it('interpreta varias versiones, la activa y la clave de índice', () => {
    const k1 = b64();
    const result = parseCryptoKeys({
      FIELD_ENCRYPTION_KEYS: `1:${k1}, 2:${b64()}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: '2',
      BLIND_INDEX_KEY: b64(),
    });
    expect(result.errors).toEqual([]);
    expect(result.value?.activeKeyVersion).toBe(2);
    expect(result.value?.encryptionKeys.get(1)?.toString('base64')).toBe(k1);
  });

  it.each([
    ['faltan todas', {}],
    ['clave corta', { FIELD_ENCRYPTION_KEYS: `1:${randomBytes(16).toString('base64')}` }],
    ['sin versión', { FIELD_ENCRYPTION_KEYS: b64() }],
    ['versión 0', { FIELD_ENCRYPTION_KEYS: `0:${b64()}` }],
    ['versión repetida', { FIELD_ENCRYPTION_KEYS: `1:${b64()},1:${b64()}` }],
    ['activa inexistente', { FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: '3' }],
    ['índice no base64', { BLIND_INDEX_KEY: 'no es base64!' }],
  ])('rechaza: %s', (_case, override) => {
    const env = {
      FIELD_ENCRYPTION_KEYS: `1:${b64()}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
      BLIND_INDEX_KEY: b64(),
      ...(_case === 'faltan todas'
        ? {
            FIELD_ENCRYPTION_KEYS: undefined,
            FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: undefined,
            BLIND_INDEX_KEY: undefined,
          }
        : override),
    };
    const result = parseCryptoKeys(env);
    expect(result.value).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rechaza que la clave de índice sea igual a una de cifrado', () => {
    const shared = b64();
    const result = parseCryptoKeys({
      FIELD_ENCRYPTION_KEYS: `1:${shared}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
      BLIND_INDEX_KEY: shared,
    });
    expect(result.errors).toContain('BLIND_INDEX_KEY: debe ser distinta de las claves de cifrado');
  });

  it('rechaza claves repetidas entre versiones', () => {
    const shared = b64();
    const result = parseCryptoKeys({
      FIELD_ENCRYPTION_KEYS: `1:${shared},2:${shared}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
      BLIND_INDEX_KEY: b64(),
    });
    expect(result.value).toBeUndefined();
  });

  it('nunca incluye el valor de las claves en los errores', () => {
    const secret = randomBytes(16).toString('base64');
    const result = parseCryptoKeys({
      FIELD_ENCRYPTION_KEYS: `1:${secret}`,
      FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
      BLIND_INDEX_KEY: secret,
    });
    expect(result.errors.join(' ')).not.toContain(secret);
  });
});
