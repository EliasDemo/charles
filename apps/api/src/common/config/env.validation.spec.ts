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
    it('con TLS, sin Swagger y CORS https, solo bloquean el correo, el push y el pago simulados', () => {
      let message = '';
      try {
        validateEnv(production);
      } catch (error) {
        message = (error as Error).message;
      }
      const problems = message.split('\n').filter((line) => line.startsWith(' - '));
      expect(problems).toEqual([
        ' - MAILER_DRIVER: el correo simulado no se permite en producción',
        ' - PUSH_DRIVER: el push simulado no se permite en producción',
        ' - PAYMENTS_GATEWAY: la pasarela simulada no se permite en producción',
      ]);
    });

    describe('Fase 8B: Izipay', () => {
      const izipay = {
        PAYMENTS_GATEWAY: 'izipay',
        IZIPAY_MODE: 'PRODUCTION',
        IZIPAY_MERCHANT_CODE: '4007701',
        IZIPAY_API_KEY: 'clave-api-real',
        IZIPAY_HASH_KEY: 'clave-hash-real',
        IZIPAY_PUBLIC_KEY: 'clave-publica-real',
        IZIPAY_RUC: '20100047218',
        PUBLIC_API_URL: 'https://api.charles.pe',
      };
      const problemsWith = (overrides: Record<string, string>): string => {
        try {
          validateEnv({ ...production, ...izipay, ...overrides });
        } catch (error) {
          return (error as Error).message;
        }
        return '';
      };

      it('con credenciales de producción no hay problemas de pagos', () => {
        expect(problemsWith({})).not.toMatch(/IZIPAY|PAYMENTS_GATEWAY|PUBLIC_API_URL/);
      });

      it('rechaza el modo de pruebas, URLs de sandbox y una URL pública sin https', () => {
        expect(problemsWith({ IZIPAY_MODE: 'TEST' })).toMatch(/IZIPAY_MODE/);
        expect(problemsWith({ IZIPAY_API_URL: 'https://sandbox-api-pw.izipay.pe' })).toMatch(
          /IZIPAY_API_URL/,
        );
        expect(problemsWith({ PUBLIC_API_URL: 'http://api.charles.pe' })).toMatch(/PUBLIC_API_URL/);
      });

      it('con PAYMENTS_GATEWAY=izipay exige todas las credenciales (en cualquier entorno)', () => {
        expect(() => validateEnv({ ...base, PAYMENTS_GATEWAY: 'izipay' })).toThrow(
          /IZIPAY_MERCHANT_CODE[\s\S]*IZIPAY_RUC[\s\S]*PUBLIC_API_URL/,
        );
        const config = validateEnv({
          ...base,
          ...izipay,
          IZIPAY_MODE: 'TEST',
          // En .env el salto de línea llega escrito como \n.
          IZIPAY_PUBLIC_KEY: String.raw`linea1\nlinea2`,
          PUBLIC_API_URL: 'http://localhost:3000/',
        });
        expect(config.payments).toMatchObject({
          gateway: 'izipay',
          publicApiUrl: 'http://localhost:3000',
          izipay: {
            apiUrl: 'https://sandbox-api-pw.izipay.pe',
            checkoutScriptUrl: 'https://sandbox-checkout.izipay.pe/payments/v1/js/index.js',
            publicKey: 'linea1\nlinea2',
          },
        });
        expect(validateEnv(base).payments.gateway).toBe('fake');
      });
    });

    it('Fase 10: con PUSH_DRIVER=expo el push ya no bloquea; el token de Expo es opcional', () => {
      let message = '';
      try {
        validateEnv({ ...production, PUSH_DRIVER: 'expo' });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain('PUSH_DRIVER');
      expect(() => validateEnv({ ...production, PUSH_DRIVER: 'apns' })).toThrow(/PUSH_DRIVER/);
    });

    it('exige la clave JWT', () => {
      expect(() => validateEnv({ ...production, JWT_PRIVATE_KEY: '' })).toThrow(/JWT_PRIVATE_KEY/);
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

    describe('Fase 14: almacenamiento de imágenes', () => {
      const s3 = {
        S3_BUCKET: 'charles-prod',
        S3_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
        S3_ACCESS_KEY_ID: 'clave-real-de-r2',
        S3_SECRET_ACCESS_KEY: 'secreto-real-de-r2',
        MEDIA_PUBLIC_BASE_URL: 'https://img.example.com',
      };
      const problemsWith = (overrides: Record<string, string>): string => {
        try {
          validateEnv({ ...production, ...s3, ...overrides });
        } catch (error) {
          return (error as Error).message;
        }
        return '';
      };

      it('con R2 y URL pública https no hay problemas de S3', () => {
        expect(problemsWith({})).not.toMatch(/S3_|MEDIA_PUBLIC/);
      });

      it('rechaza credenciales de desarrollo (minioadmin, charles_local_only)', () => {
        expect(problemsWith({ S3_ACCESS_KEY_ID: 'minioadmin' })).toMatch(/S3_ACCESS_KEY_ID/);
        expect(problemsWith({ S3_SECRET_ACCESS_KEY: 'minioadmin' })).toMatch(/S3_SECRET/);
        expect(problemsWith({ S3_ACCESS_KEY_ID: 'charles_local_only' })).toMatch(/S3_ACCESS/);
        expect(problemsWith({ S3_SECRET_ACCESS_KEY: 'charles_local_only_secret' })).toMatch(
          /S3_SECRET/,
        );
      });

      it('rechaza un endpoint local', () => {
        expect(problemsWith({ S3_ENDPOINT: 'http://localhost:9000' })).toMatch(/S3_ENDPOINT/);
        expect(problemsWith({ S3_ENDPOINT: 'http://127.0.0.1:9000' })).toMatch(/S3_ENDPOINT/);
      });

      it('exige MEDIA_PUBLIC_BASE_URL con https', () => {
        expect(problemsWith({ MEDIA_PUBLIC_BASE_URL: '' })).toMatch(/MEDIA_PUBLIC_BASE_URL/);
        expect(problemsWith({ MEDIA_PUBLIC_BASE_URL: 'http://img.example.com' })).toMatch(
          /MEDIA_PUBLIC_BASE_URL/,
        );
      });

      it('fuera de producción admite el almacenamiento local', () => {
        const config = validateEnv({
          ...base,
          S3_BUCKET: 'charles-dev',
          S3_ENDPOINT: 'http://127.0.0.1:9000',
          S3_ACCESS_KEY_ID: 'charles_local_only',
          S3_SECRET_ACCESS_KEY: 'charles_local_only_secret',
          S3_FORCE_PATH_STYLE: 'true',
          MEDIA_PUBLIC_BASE_URL: 'https://img.example.com/',
        });
        expect(config.storage).toMatchObject({
          bucket: 'charles-dev',
          forcePathStyle: true,
          publicBaseUrl: 'https://img.example.com',
        });
      });
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
