/**
 * Nombre de usuario: público (en lugar del nombre real) y para iniciar sesión.
 *
 * Formato: 3 a 20 caracteres; minúsculas, números, punto y guion bajo; sin empezar ni terminar en
 * punto o guion bajo y sin dos seguidos. Se guarda en minúsculas (citext: sin distinguir
 * mayúsculas). La base tiene la misma regla (users_username_format_check).
 */

export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|[._](?![._])){1,18}[a-z0-9]$/;
/** Se puede cambiar una vez cada 30 días. */
export const USERNAME_CHANGE_DAYS = 30;

/**
 * Nombres que podrían suplantar a Charles, al personal o a funciones de la app. También se
 * rechaza todo usuario que **contenga** "charles", "admin" o "soporte".
 */
const RESERVED = new Set([
  'charles',
  'admin',
  'administrador',
  'soporte',
  'support',
  'ayuda',
  'help',
  'staff',
  'sistema',
  'system',
  'root',
  'moderador',
  'moderator',
  'oficial',
  'official',
  'seguridad',
  'security',
  'barberia',
  'barbero',
  'cliente',
  'null',
  'undefined',
  'me',
]);
const RESERVED_PARTS = ['charles', 'admin', 'soporte', 'support'];

export type UsernameProblem = 'INVALID' | 'RESERVED';

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** `null` si es válido; si no, el motivo. Recibe el valor ya normalizado. */
export function usernameProblem(username: string): UsernameProblem | null {
  if (!USERNAME_PATTERN.test(username)) return 'INVALID';
  if (RESERVED.has(username) || RESERVED_PARTS.some((part) => username.includes(part))) {
    return 'RESERVED';
  }
  return null;
}
