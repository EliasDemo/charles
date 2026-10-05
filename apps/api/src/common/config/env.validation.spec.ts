import { randomCryptoEnv } from '../../../test/support/random-keys';
import { NodeEnv, parseCorsOrigins, parseTrustProxy, validateEnv } from './env.validation';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  CORS_ORIGINS: 'http://localhost:3001',
  TRUST_PROXY: 'loopback',
  ...randomCryptoEnv(),
};

const production = {
  ...base,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@db.internal:5432/db?sslmode=verify-full',
  REDIS_URL: 'rediss://cache.internal:6380/0',
  CORS_ORIGINS: 'https://app.example.com',
  SWAGGER_ENABLED: 'false',
};

describe('validateEnv', () => {
  it('acepta un entorno válido y aplica valores por defecto', () => {
    const config = validateEnv(base);
    expect(config).toMatchObject({
      nodeEnv: NodeEnv.Development,
      isProduction: false,
      port: 3000,
      corsOrigins: ['http://localhost:3001'],
      trustProxy: ['loopback'],
      swaggerEnabled: false,
      bodyLimit: '100kb',
      throttle: { ttlMs: 60_000, limit: 100 },
    });
    expect(config.crypto.activeKeyVersion).toBe(1);
    expect(config.crypto.blindIndexKey).toHaveLength(32);
  });

  it('convierte números y booleanos desde texto', () => {
    const config = validateEnv({
      ...base,
      PORT: '8080',
      SWAGGER_ENABLED: 'true',
      THROTTLE_LIMIT: '5',
    });
    expect(config.port).toBe(8080);
    expect(config.swaggerEnabled).toBe(true);
    expect(config.throttle.limit).toBe(5);
  });

  it.each([
    'NODE_ENV',
    'DATABASE_URL',
    'REDIS_URL',
    'CORS_ORIGINS',
    'TRUST_PROXY',
    'FIELD_ENCRYPTION_KEYS',
    'FIELD_ENCRYPTION_ACTIVE_KEY_VERSION',
    'BLIND_INDEX_KEY',
  ])('no arranca si falta %s', (key) => {
    const env: Record<string, string> = { ...base };
    delete env[key];
    expect(() => validateEnv(env)).toThrow(new RegExp(key));
  });

  it('no incluye valores de las variables en el mensaje de error', () => {
    const secret = 'postgresql-sin-esquema-secreto';
    expect(() => validateEnv({ ...base, DATABASE_URL: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });

  it('rechaza puerto y formato de BODY_LIMIT inválidos', () => {
    expect(() => validateEnv({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...base, BODY_LIMIT: '1gb' })).toThrow(/BODY_LIMIT/);
  });

  describe('producción', () => {
    it('acepta una configuración segura', () => {
      expect(validateEnv(production).isProduction).toBe(true);
    });

    it('exige sslmode=verify-full en PostgreSQL', () => {
      expect(() =>
        validateEnv({ ...production, DATABASE_URL: 'postgresql://u:p@db:5432/db?sslmode=require' }),
      ).toThrow(/verify-full/);
    });

    it('exige TLS en Redis', () => {
      expect(() => validateEnv({ ...production, REDIS_URL: 'redis://cache:6379' })).toThrow(
        /rediss/,
      );
    });

    it('prohíbe Swagger', () => {
      expect(() => validateEnv({ ...production, SWAGGER_ENABLED: 'true' })).toThrow(/SWAGGER/);
    });

    it('exige orígenes CORS https', () => {
      expect(() => validateEnv({ ...production, CORS_ORIGINS: 'http://app.example.com' })).toThrow(
        /https/,
      );
    });
  });
});

describe('parseCorsOrigins', () => {
  it('separa y limpia la lista', () => {
    expect(parseCorsOrigins(' https://a.com , https://b.com:8443 ')).toEqual({
      value: ['https://a.com', 'https://b.com:8443'],
      errors: [],
    });
  });

  it.each(['*', 'https://*.example.com', 'https://a.com/ruta', 'no-es-url', 'ftp://a.com', ''])(
    'rechaza %p',
    (origin) => {
      expect(parseCorsOrigins(origin).errors.length).toBeGreaterThan(0);
    },
  );
});

describe('parseTrustProxy', () => {
  it.each([
    ['false', false],
    ['1', 1],
    ['loopback', ['loopback']],
    ['10.0.0.0/8, 192.168.1.1, uniquelocal', ['10.0.0.0/8', '192.168.1.1', 'uniquelocal']],
    ['::1, fd00::/8', ['::1', 'fd00::/8']],
  ])('interpreta %p', (raw, expected) => {
    expect(parseTrustProxy(raw)).toEqual({ value: expected, errors: [] });
  });

  it.each(['true', '10.0.0.0/33', 'proxy.local', '999.1.1.1', ''])('rechaza %p', (raw) => {
    expect(parseTrustProxy(raw).errors.length).toBeGreaterThan(0);
  });
});
