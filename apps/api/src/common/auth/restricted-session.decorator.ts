import { SetMetadata } from '@nestjs/common';
import type { RestrictedScope } from './auth-user';

export const ALLOW_RESTRICTED_SESSION_KEY = 'allowRestrictedSession';

/**
 * Permite el endpoint a una sesión restringida de esos alcances (por defecto `support`: los
 * tickets propios de una cuenta deshabilitada). Cualquier otro endpoint la rechaza con 403.
 */
export const AllowRestrictedSession = (
  ...scopes: RestrictedScope[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_RESTRICTED_SESSION_KEY, scopes.length > 0 ? scopes : ['support']);
