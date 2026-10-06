import { randomBytes } from 'node:crypto';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { StaticKeyProvider } from '../../common/crypto/key-provider';
import { AppException } from '../../common/errors/app.exception';
import { SearchCursor } from './search-cursor';
import { likePattern } from './search.repository';

const cursor = new SearchCursor(
  new EncryptionService(
    new StaticKeyProvider({
      encryptionKeys: new Map([[1, randomBytes(32)]]),
      activeKeyVersion: 1,
      blindIndexKey: randomBytes(32),
    }),
  ),
);

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return undefined;
};

describe('SearchCursor', () => {
  it('ida y vuelta: recupera los valores de la clave de orden', () => {
    const encoded = cursor.encode('distance', [1234, '0199aaaa-0000-7000-8000-000000000001']);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor.decode(encoded, 'distance', 2)).toEqual([
      1234,
      '0199aaaa-0000-7000-8000-000000000001',
    ]);
  });

  it('RF-BUS-002: el cursor no revela la distancia (va cifrado)', () => {
    const encoded = cursor.encode('distance', [987654, 'id']);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).not.toContain('987654');
  });

  it('rechaza un cursor alterado, de otro orden, con otra cantidad de claves o basura', () => {
    const encoded = cursor.encode('rating', [1, 450, 10, 'id']);
    const bytes = Buffer.from(encoded, 'base64url');
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x01;
    expect(codeOf(() => cursor.decode(bytes.toString('base64url'), 'rating', 4))).toBe(
      'INVALID_CURSOR',
    );
    expect(codeOf(() => cursor.decode(encoded, 'price', 4))).toBe('INVALID_CURSOR');
    expect(codeOf(() => cursor.decode(encoded, 'rating', 2))).toBe('INVALID_CURSOR');
    expect(codeOf(() => cursor.decode('basura', 'rating', 4))).toBe('INVALID_CURSOR');
  });
});

describe('likePattern', () => {
  it('escapa los comodines: el texto se busca literal', () => {
    expect(likePattern('corte')).toBe('%corte%');
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});
