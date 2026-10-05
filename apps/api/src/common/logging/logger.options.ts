import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { LoggerOptions } from 'pino';
import { type AppConfig, NodeEnv } from '../config/env.validation';

export const REQUEST_ID_HEADER = 'x-request-id';
export const REDACTED = '[REDACTED]';

/** Un ID entrante solo se reutiliza si es seguro (evita inyección en logs). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Claves cuyo valor nunca debe aparecer en los logs, a cualquier profundidad razonable.
 * Incluye credenciales, datos personales y cuerpos de pago (CLAUDE.md §6.6).
 */
export const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'resetToken',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
  'email',
  'phone',
  'documentNumber',
  'birthDate',
  'cardNumber',
  'cvv',
  'card',
  'paymentPayload',
  'body',
] as const;

const SENSITIVE_KEY_SET = new Set<string>(SENSITIVE_KEYS.map((k) => k.toLowerCase()));

const MAX_REDACT_DEPTH = 4;

export function buildRedactPaths(): string[] {
  const paths = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["idempotency-key"]',
    'res.headers["set-cookie"]',
  ];
  for (const key of SENSITIVE_KEYS) {
    for (let depth = 0; depth < MAX_REDACT_DEPTH; depth++) {
      paths.push(`${'*.'.repeat(depth)}${key}`);
    }
  }
  return [...new Set(paths)];
}

/** Enmascara los valores de parámetros sensibles en la query string de una URL. */
export function maskUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const index = url.indexOf('?');
  if (index === -1) return url;
  const params = new URLSearchParams(url.slice(index + 1));
  for (const key of [...params.keys()]) {
    if (SENSITIVE_KEY_SET.has(key.toLowerCase())) params.set(key, REDACTED);
  }
  return `${url.slice(0, index)}?${params.toString()}`;
}

type RequestWithId = IncomingMessage & { id?: unknown };

/** Reutiliza el ID ya asignado, o el entrante si es seguro, o genera uno nuevo. */
export function resolveRequestId(req: RequestWithId, res: ServerResponse): string {
  if (typeof req.id === 'string') return req.id;
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  return id;
}

/** Asigna el ID de petición antes que cualquier otro middleware (incluido el body-parser). */
export function requestIdMiddleware(
  req: RequestWithId,
  res: ServerResponse,
  next: () => void,
): void {
  resolveRequestId(req, res);
  next();
}

/** Opciones base de pino (también usadas por las pruebas de enmascarado). */
export function buildPinoOptions(config: Pick<AppConfig, 'logLevel'>): LoggerOptions {
  return {
    level: config.logLevel,
    redact: { paths: buildRedactPaths(), censor: REDACTED },
  };
}

export function buildLoggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      ...buildPinoOptions(config),
      genReqId: resolveRequestId,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        // `ip` es la IP real del cliente, resuelta por Express según TRUST_PROXY.
        req: (req: { id: unknown; method: string; url: string; raw?: { ip?: string } }) => ({
          id: req.id,
          method: req.method,
          url: maskUrl(req.url),
          ip: req.raw?.ip,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      transport:
        config.nodeEnv === NodeEnv.Development
          ? { target: 'pino-pretty', options: { singleLine: true } }
          : undefined,
    },
  };
}
