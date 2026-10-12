import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Sesión de la web (charlesweb): los tokens viajan en cookies `HttpOnly` (nunca al alcance de
 * JavaScript) y las peticiones que cambian datos exigen el token CSRF por doble envío: la cookie
 * `charles_csrf` (legible) debe coincidir con la cabecera `X-CSRF-Token`. La app móvil no usa
 * cookies: sigue con `Authorization: Bearer`.
 */
export const WEB_COOKIES = {
  access: 'charles_at',
  refresh: 'charles_rt',
  csrf: 'charles_csrf',
} as const;

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // cookie mal formada: se ignora
    }
  }
  return out;
}

export function cookieOf(req: Pick<Request, 'headers'>, name: string): string | undefined {
  return parseCookies(req.headers.cookie)[name] || undefined;
}

/** Doble envío: la cabecera coincide con la cookie. Los métodos de solo lectura no lo exigen. */
export function isCsrfValid(req: Pick<Request, 'headers' | 'method'>): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const cookie = cookieOf(req, WEB_COOKIES.csrf);
  const header = req.headers[CSRF_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (!cookie || !value || cookie.length !== value.length) return false;
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(value));
}
