import { isIP } from 'node:net';
import { type JwtKeys, parseJwtPrivateKey } from '../auth/jwt-keys';
import { type CryptoKeys, parseCryptoKeys } from '../crypto/crypto-keys';
import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum MailerDriver {
  /** Simulado: guarda los correos en Redis. Prohibido en producción (proveedor real: Fase 10). */
  Fake = 'fake',
}

/** Fase 10: envío de notificaciones push. */
export enum PushDriver {
  /** Simulado: guarda los envíos en Redis. Prohibido en producción. */
  Fake = 'fake',
  /** Expo Push Service (la app es Expo; entrega a iOS y Android). */
  Expo = 'expo',
}

/** Fase 8B: pasarela de pagos. `fake` solo fuera de producción. */
export enum PaymentsGateway {
  Fake = 'fake',
  Izipay = 'izipay',
  MercadoPago = 'mercadopago',
}

export enum IzipayMode {
  Test = 'TEST',
  Production = 'PRODUCTION',
}

export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
  Silent = 'silent',
}

/**
 * Valor de `trust proxy` de Express:
 * - `false`: no se confía en ningún proxy (se ignora X-Forwarded-For).
 * - número: cantidad de saltos de proxy de confianza.
 * - lista: IPs, CIDR o los alias `loopback`, `linklocal`, `uniquelocal`.
 * `true` (confiar en cualquiera) está prohibido: permitiría falsificar la IP del cliente.
 */
export type TrustProxySetting = false | number | string[];

const TRUST_PROXY_ALIASES = new Set(['loopback', 'linklocal', 'uniquelocal']);

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

const toInt = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  @Matches(/^postgres(ql)?:\/\/\S+$/, { message: 'debe ser una URL postgresql://' })
  DATABASE_URL!: string;

  /**
   * Conexiones máximas del pool de PostgreSQL por instancia de la API. Recomendado: 10 (ver
   * CLAUDE.md §2). Total del servidor = instancias × este valor, por debajo de max_connections.
   */
  @Transform(toInt)
  @IsInt()
  @Min(2)
  @Max(100)
  DATABASE_POOL_MAX = 10;

  @IsString()
  @Matches(/^rediss?:\/\/\S+$/, { message: 'debe ser una URL redis:// o rediss://' })
  REDIS_URL!: string;

  /** Orígenes permitidos para CORS, separados por coma. */
  @IsString()
  CORS_ORIGINS!: string;

  /** Ver {@link TrustProxySetting}. */
  @IsString()
  TRUST_PROXY!: string;

  @Transform(toBoolean)
  @IsBoolean()
  SWAGGER_ENABLED = false;

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  @IsString()
  @Matches(/^\d+(b|kb|mb)$/, { message: 'debe tener el formato <número>(b|kb|mb)' })
  BODY_LIMIT = '100kb';

  @Transform(toInt)
  @IsInt()
  @Min(1000)
  THROTTLE_TTL_MS = 60_000;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT = 100;

  @IsString()
  JWT_ISSUER = 'charles-api';

  @IsString()
  JWT_AUDIENCE = 'charles-clients';

  /** Vida del token de acceso (CLAUDE.md §6.3: 15 minutos). */
  @Transform(toInt)
  @IsInt()
  @Min(60)
  @Max(3600)
  ACCESS_TOKEN_TTL_SECONDS = 900;

  /** Vida de la sesión (token de renovación), renovada con el uso (CLAUDE.md §4.1: 30 días). */
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(365)
  REFRESH_TOKEN_TTL_DAYS = 30;

  /**
   * Gracia de la rotación del token de renovación, en segundos (0 la desactiva). Si el mismo
   * token llega otra vez dentro de esta ventana (reintento o carrera de red de la app), se devuelve
   * el mismo sucesor en lugar de tratarlo como robo.
   */
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(60)
  REFRESH_TOKEN_GRACE_SECONDS = 10;

  @IsEnum(MailerDriver)
  MAILER_DRIVER: MailerDriver = MailerDriver.Fake;

  @IsEnum(PushDriver)
  PUSH_DRIVER: PushDriver = PushDriver.Fake;

  /**
   * Token de acceso de Expo (opcional; obligatorio si se activa "enhanced push security" en el
   * proyecto de Expo). Secreto: solo en `.env`.
   */
  @IsOptional()
  @IsString()
  EXPO_ACCESS_TOKEN?: string;

  /**
   * Trabajos programados (vencer reservas sin pago, publicar el outbox). Las e2e los apagan y
   * ejecutan cada trabajo a mano, con el reloj fijo.
   */
  @Transform(toBoolean)
  @IsBoolean()
  SCHEDULED_JOBS_ENABLED = true;

  // ───────────── Fase 14: almacenamiento de imágenes (S3: SeaweedFS local, R2 en producción) ─────────────

  /** Endpoint S3 (en R2: https://<cuenta>.r2.cloudflarestorage.com). Vacío = AWS. */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  S3_ENDPOINT?: string;

  @IsString()
  S3_REGION = 'auto';

  /** Bucket de imágenes. Sin él, las subidas responden 503 (imágenes desactivadas). */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
  S3_BUCKET?: string;

  /** Credenciales S3: solo en `.env`, nunca en el repositorio. */
  @IsOptional()
  @IsString()
  S3_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  S3_SECRET_ACCESS_KEY?: string;

  /** SeaweedFS y MinIO usan rutas (`endpoint/bucket/clave`); R2 y AWS, no hace falta. */
  @Transform(toBoolean)
  @IsBoolean()
  S3_FORCE_PATH_STYLE = false;

  /**
   * URL pública de las imágenes (en R2: el dominio público del bucket o un CDN). Si falta, la
   * propia API las sirve en `/api/v1/media/...` (solo fuera de producción).
   */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  MEDIA_PUBLIC_BASE_URL?: string;

  // ───────────── Sesión web (charlesweb): cookies HttpOnly y CSRF ─────────────

  /** Dominio de las cookies de la web (p. ej. `.charles.pe`). Vacío = solo el host de la API. */
  @IsOptional()
  @IsString()
  @Matches(/^\.?[a-z0-9.-]+$/)
  COOKIE_DOMAIN?: string;

  /** `Secure` en las cookies. En producción, siempre true. (localhost lo admite en http.) */
  @Transform(toBoolean)
  @IsBoolean()
  COOKIE_SECURE = true;

  // ───────────── Fase 8B: pagos con Izipay (botón de pagos, developers.izipay.pe) ─────────────

  @IsEnum(PaymentsGateway)
  PAYMENTS_GATEWAY: PaymentsGateway = PaymentsGateway.Fake;

  /**
   * URL pública de esta API (sin `/api/v1`): con ella se arman la página de pago, el regreso del
   * formulario y la URL de notificación (IPN) que se envía a Izipay en cada pago.
   */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  PUBLIC_API_URL?: string;

  @IsEnum(IzipayMode)
  IZIPAY_MODE: IzipayMode = IzipayMode.Test;

  /** Credenciales de Izipay (panel → Desarrolladores → Claves): solo en `.env`. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,15}$/)
  IZIPAY_MERCHANT_CODE?: string;

  /** "Clave de API del nuevo botón de pagos": solo para generar el token de sesión. */
  @IsOptional()
  @IsString()
  IZIPAY_API_KEY?: string;

  /** "Clave hash": firma HMAC-SHA256 de las respuestas y notificaciones. */
  @IsOptional()
  @IsString()
  IZIPAY_HASH_KEY?: string;

  /** "Clave pública" RSA que usa el formulario (`keyRSA`). Se admite con `\n` escapados. */
  @IsOptional()
  @IsString()
  IZIPAY_PUBLIC_KEY?: string;

  /** RUC del comercio (Charles): lo exige la API de devoluciones. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{11}$/)
  IZIPAY_RUC?: string;

  /** Por defecto, el de pruebas o el de producción según IZIPAY_MODE. */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  IZIPAY_API_URL?: string;

  /** Script del formulario web. Por defecto, el de pruebas o el de producción según el modo. */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  IZIPAY_CHECKOUT_SCRIPT_URL?: string;

  // ───────────── Pagos con Mercado Pago (Checkout Pro, API de Preferences) ─────────────

  /** Access Token de la aplicación ("Tus integraciones"): solo en `.env`. */
  @IsOptional()
  @IsString()
  MERCADOPAGO_ACCESS_TOKEN?: string;

  /** Clave secreta de los webhooks (Webhooks → Configurar notificación): firma `x-signature`. */
  @IsOptional()
  @IsString()
  MERCADOPAGO_WEBHOOK_SECRET?: string;

  /** Marketplace: Client ID y Client Secret de la aplicación, para vincular la cuenta de cada barbería (OAuth). */
  @IsOptional()
  @IsString()
  MERCADOPAGO_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  MERCADOPAGO_CLIENT_SECRET?: string;

  /** Por defecto https://api.mercadopago.com (las pruebas usan otra URL local). */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  MERCADOPAGO_API_URL?: string;
}

/** Configuración ya validada e interpretada que consume la aplicación. */
export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  databasePoolMax: number;
  redisUrl: string;
  corsOrigins: string[];
  trustProxy: TrustProxySetting;
  swaggerEnabled: boolean;
  logLevel: LogLevel;
  bodyLimit: string;
  throttle: { ttlMs: number; limit: number };
  /** Claves de cifrado de campos e índice ciego. Nunca registrar este objeto en logs. */
  crypto: CryptoKeys;
  auth: {
    /** Claves ES256 del token de acceso. Nunca registrar en logs. */
    jwtKeys: JwtKeys;
    issuer: string;
    audience: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlDays: number;
    refreshTokenGraceSeconds: number;
  };
  mail: { driver: MailerDriver };
  push: { driver: PushDriver; expoAccessToken: string | null };
  scheduledJobsEnabled: boolean;
  web: { cookieDomain: string | null; cookieSecure: boolean };
  /** Nunca registrar este objeto en logs (lleva credenciales). */
  payments: {
    gateway: PaymentsGateway;
    publicApiUrl: string | null;
    mercadoPago: {
      accessToken: string | null;
      webhookSecret: string | null;
      apiUrl: string;
      clientId: string | null;
      clientSecret: string | null;
    };
    izipay: {
      mode: IzipayMode;
      merchantCode: string | null;
      apiKey: string | null;
      hashKey: string | null;
      publicKey: string | null;
      ruc: string | null;
      apiUrl: string;
      checkoutScriptUrl: string;
    };
  };
  /** Nunca registrar este objeto en logs (lleva credenciales). */
  storage: {
    bucket: string | null;
    endpoint: string | null;
    region: string;
    accessKeyId: string | null;
    secretAccessKey: string | null;
    forcePathStyle: boolean;
    publicBaseUrl: string | null;
  };
}

interface Parsed<T> {
  value: T;
  errors: string[];
}

export function parseCorsOrigins(raw: string): Parsed<string[]> {
  const errors: string[] = [];
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (origins.length === 0) errors.push('CORS_ORIGINS: debe contener al menos un origen');

  for (const origin of origins) {
    if (origin.includes('*')) {
      errors.push('CORS_ORIGINS: no se permiten comodines (*)');
      continue;
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      errors.push(`CORS_ORIGINS: origen inválido "${origin}"`);
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      errors.push(`CORS_ORIGINS: "${origin}" debe ser un origen exacto (esquema://host[:puerto])`);
    }
  }
  return { value: origins, errors };
}

function isIpOrCidr(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || address === undefined) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

export function parseTrustProxy(raw: string): Parsed<TrustProxySetting> {
  const value = raw.trim();
  if (value === 'false') return { value: false, errors: [] };
  if (value === 'true') {
    return {
      value: false,
      errors: ['TRUST_PROXY: "true" no está permitido; indica saltos, IPs o rangos de confianza'],
    };
  }
  if (/^\d+$/.test(value)) return { value: Number(value), errors: [] };

  const entries = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invalid = entries.filter((e) => !TRUST_PROXY_ALIASES.has(e) && !isIpOrCidr(e));
  if (entries.length === 0 || invalid.length > 0) {
    return {
      value: false,
      errors: [`TRUST_PROXY: valores inválidos (${invalid.join(', ') || 'vacío'})`],
    };
  }
  return { value: entries, errors: [] };
}

function productionErrors(env: EnvironmentVariables, corsOrigins: string[]): string[] {
  const errors: string[] = [];
  if (!/[?&]sslmode=verify-full(&|$)/.test(env.DATABASE_URL)) {
    errors.push('DATABASE_URL: en producción debe incluir sslmode=verify-full');
  }
  if (!env.REDIS_URL.startsWith('rediss://')) {
    errors.push('REDIS_URL: en producción debe usar TLS (rediss://)');
  }
  if (env.SWAGGER_ENABLED) {
    errors.push('SWAGGER_ENABLED: debe estar deshabilitado en producción');
  }
  if (env.MAILER_DRIVER === MailerDriver.Fake) {
    errors.push('MAILER_DRIVER: el correo simulado no se permite en producción');
  }
  if (env.PUSH_DRIVER === PushDriver.Fake) {
    errors.push('PUSH_DRIVER: el push simulado no se permite en producción');
  }
  if (env.S3_BUCKET) {
    if (env.S3_ENDPOINT && /\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(env.S3_ENDPOINT)) {
      errors.push('S3_ENDPOINT: en producción no puede ser local');
    }
    const localKeys = ['minioadmin', 'charles_local_only'];
    if (!env.S3_ACCESS_KEY_ID || localKeys.includes(env.S3_ACCESS_KEY_ID)) {
      errors.push('S3_ACCESS_KEY_ID: en producción no se permiten credenciales de desarrollo');
    }
    if (
      !env.S3_SECRET_ACCESS_KEY ||
      /^(minioadmin|charles_local_only)/.test(env.S3_SECRET_ACCESS_KEY)
    ) {
      errors.push('S3_SECRET_ACCESS_KEY: en producción no se permiten credenciales de desarrollo');
    }
    if (!env.MEDIA_PUBLIC_BASE_URL?.startsWith('https://')) {
      errors.push('MEDIA_PUBLIC_BASE_URL: en producción es obligatoria y con https');
    }
  }
  if (corsOrigins.some((o) => !o.startsWith('https://'))) {
    errors.push('CORS_ORIGINS: en producción todos los orígenes deben usar https');
  }
  if (!env.COOKIE_SECURE) {
    errors.push('COOKIE_SECURE: en producción las cookies deben ser Secure');
  }
  if (env.PAYMENTS_GATEWAY === PaymentsGateway.Fake) {
    errors.push('PAYMENTS_GATEWAY: la pasarela simulada no se permite en producción');
  }
  if (env.PAYMENTS_GATEWAY === PaymentsGateway.Izipay) {
    if (env.IZIPAY_MODE !== IzipayMode.Production) {
      errors.push('IZIPAY_MODE: en producción debe ser PRODUCTION (nunca credenciales de prueba)');
    }
    const urls = [env.IZIPAY_API_URL, env.IZIPAY_CHECKOUT_SCRIPT_URL].filter(Boolean) as string[];
    if (urls.some((u) => /sandbox|localhost|127\./.test(u) || !u.startsWith('https://'))) {
      errors.push('IZIPAY_API_URL: en producción no puede apuntar al entorno de pruebas');
    }
    if (!env.PUBLIC_API_URL?.startsWith('https://')) {
      errors.push('PUBLIC_API_URL: en producción es obligatoria y con https');
    }
  }
  if (env.PAYMENTS_GATEWAY === PaymentsGateway.MercadoPago) {
    if (env.MERCADOPAGO_ACCESS_TOKEN?.startsWith('TEST-')) {
      errors.push('MERCADOPAGO_ACCESS_TOKEN: en producción no se permiten credenciales de prueba');
    }
    if (
      env.MERCADOPAGO_API_URL &&
      !env.MERCADOPAGO_API_URL.startsWith('https://api.mercadopago.com')
    ) {
      errors.push('MERCADOPAGO_API_URL: en producción debe ser https://api.mercadopago.com');
    }
    if (!env.PUBLIC_API_URL?.startsWith('https://')) {
      errors.push('PUBLIC_API_URL: en producción es obligatoria y con https');
    }
  }
  return errors;
}

/** Con Mercado Pago, sus credenciales y la URL pública son obligatorias (en cualquier entorno). */
function mercadoPagoErrors(env: EnvironmentVariables): string[] {
  if (env.PAYMENTS_GATEWAY !== PaymentsGateway.MercadoPago) return [];
  const required = {
    MERCADOPAGO_ACCESS_TOKEN: env.MERCADOPAGO_ACCESS_TOKEN,
    MERCADOPAGO_WEBHOOK_SECRET: env.MERCADOPAGO_WEBHOOK_SECRET,
    PUBLIC_API_URL: env.PUBLIC_API_URL,
  };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => `${name}: obligatoria con PAYMENTS_GATEWAY=mercadopago`);
}

const IZIPAY_URLS = {
  [IzipayMode.Test]: {
    api: 'https://sandbox-api-pw.izipay.pe',
    script: 'https://sandbox-checkout.izipay.pe/payments/v1/js/index.js',
  },
  [IzipayMode.Production]: {
    api: 'https://api-pw.izipay.pe',
    script: 'https://checkout.izipay.pe/payments/v1/js/index.js',
  },
} as const;

/** Con la pasarela de Izipay, todas sus credenciales son obligatorias (en cualquier entorno). */
function izipayErrors(env: EnvironmentVariables): string[] {
  if (env.PAYMENTS_GATEWAY !== PaymentsGateway.Izipay) return [];
  const required = {
    IZIPAY_MERCHANT_CODE: env.IZIPAY_MERCHANT_CODE,
    IZIPAY_API_KEY: env.IZIPAY_API_KEY,
    IZIPAY_HASH_KEY: env.IZIPAY_HASH_KEY,
    IZIPAY_PUBLIC_KEY: env.IZIPAY_PUBLIC_KEY,
    IZIPAY_RUC: env.IZIPAY_RUC,
    PUBLIC_API_URL: env.PUBLIC_API_URL,
  };
  return Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => `${name}: obligatoria con PAYMENTS_GATEWAY=izipay`);
}

/**
 * Valida las variables de entorno al arrancar. Si algo falta o es inválido,
 * lanza un error y la aplicación no inicia. Nunca incluye valores en el mensaje.
 */
export function validateEnv(raw: Record<string, unknown>): AppConfig {
  const env = plainToInstance(EnvironmentVariables, raw, { exposeDefaultValues: true });
  const errors: string[] = validateSync(env).map(
    (e) => `${e.property}: ${Object.values(e.constraints ?? {}).join('; ') || 'inválido'}`,
  );

  const cors: Parsed<string[]> =
    typeof env.CORS_ORIGINS === 'string'
      ? parseCorsOrigins(env.CORS_ORIGINS)
      : { value: [], errors: [] };
  const trustProxy: Parsed<TrustProxySetting> =
    typeof env.TRUST_PROXY === 'string'
      ? parseTrustProxy(env.TRUST_PROXY)
      : { value: false, errors: [] };
  const crypto = parseCryptoKeys(raw);
  const jwtKeys = parseJwtPrivateKey(raw.JWT_PRIVATE_KEY);
  errors.push(...cors.errors, ...trustProxy.errors, ...crypto.errors, ...jwtKeys.errors);
  errors.push(...izipayErrors(env), ...mercadoPagoErrors(env));

  // Las reglas de producción solo se evalúan si los campos básicos son válidos.
  if (errors.length === 0 && env.NODE_ENV === NodeEnv.Production) {
    errors.push(...productionErrors(env, cors.value));
  }

  if (errors.length > 0 || !crypto.value || !jwtKeys.value) {
    throw new Error(`Configuración de entorno inválida:\n - ${errors.join('\n - ')}`);
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === NodeEnv.Production,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    databasePoolMax: env.DATABASE_POOL_MAX,
    redisUrl: env.REDIS_URL,
    corsOrigins: cors.value,
    trustProxy: trustProxy.value,
    swaggerEnabled: env.SWAGGER_ENABLED,
    logLevel: env.LOG_LEVEL,
    bodyLimit: env.BODY_LIMIT,
    throttle: { ttlMs: env.THROTTLE_TTL_MS, limit: env.THROTTLE_LIMIT },
    crypto: crypto.value,
    auth: {
      jwtKeys: jwtKeys.value,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      refreshTokenGraceSeconds: env.REFRESH_TOKEN_GRACE_SECONDS,
    },
    mail: { driver: env.MAILER_DRIVER },
    push: { driver: env.PUSH_DRIVER, expoAccessToken: env.EXPO_ACCESS_TOKEN || null },
    web: { cookieDomain: env.COOKIE_DOMAIN || null, cookieSecure: env.COOKIE_SECURE },
    payments: {
      gateway: env.PAYMENTS_GATEWAY,
      publicApiUrl: env.PUBLIC_API_URL?.replace(/\/+$/, '') || null,
      mercadoPago: {
        accessToken: env.MERCADOPAGO_ACCESS_TOKEN || null,
        webhookSecret: env.MERCADOPAGO_WEBHOOK_SECRET || null,
        clientId: env.MERCADOPAGO_CLIENT_ID || null,
        clientSecret: env.MERCADOPAGO_CLIENT_SECRET || null,
        apiUrl: (env.MERCADOPAGO_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, ''),
      },
      izipay: {
        mode: env.IZIPAY_MODE,
        merchantCode: env.IZIPAY_MERCHANT_CODE || null,
        apiKey: env.IZIPAY_API_KEY || null,
        hashKey: env.IZIPAY_HASH_KEY || null,
        publicKey: env.IZIPAY_PUBLIC_KEY?.replace(/\\n/g, '\n') || null,
        ruc: env.IZIPAY_RUC || null,
        apiUrl: (env.IZIPAY_API_URL || IZIPAY_URLS[env.IZIPAY_MODE].api).replace(/\/+$/, ''),
        checkoutScriptUrl: env.IZIPAY_CHECKOUT_SCRIPT_URL || IZIPAY_URLS[env.IZIPAY_MODE].script,
      },
    },
    storage: {
      bucket: env.S3_BUCKET || null,
      endpoint: env.S3_ENDPOINT || null,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID || null,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || null,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL?.replace(/\/+$/, '') || null,
    },
    scheduledJobsEnabled: env.SCHEDULED_JOBS_ENABLED,
  };
}
