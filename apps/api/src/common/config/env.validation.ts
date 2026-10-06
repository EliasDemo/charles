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
  if (corsOrigins.some((o) => !o.startsWith('https://'))) {
    errors.push('CORS_ORIGINS: en producción todos los orígenes deben usar https');
  }
  return errors;
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
    scheduledJobsEnabled: env.SCHEDULED_JOBS_ENABLED,
  };
}
