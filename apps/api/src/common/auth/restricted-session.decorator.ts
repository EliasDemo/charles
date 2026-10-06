import { SetMetadata } from '@nestjs/common';

export const ALLOW_RESTRICTED_SESSION_KEY = 'allowRestrictedSession';

/**
 * Permite el endpoint a la sesión restringida de una cuenta deshabilitada (Fase 12): solo los
 * tickets de soporte propios. Todo lo demás la rechaza con 403 `ACCOUNT_DISABLED`.
 */
export const AllowRestrictedSession = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_RESTRICTED_SESSION_KEY, true);
