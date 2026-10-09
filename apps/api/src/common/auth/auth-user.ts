import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '../../generated/prisma/enums';

export type RestrictedScope = 'support' | 'deletion';

/** Usuario autenticado: siempre sale del token verificado, nunca del cuerpo de la petición. */
export interface AuthUser {
  id: string;
  roles: Role[];
  /** Familia de sesión (`refresh_tokens.family_id`). */
  sessionId: string;
  /**
   * Sesión restringida, sin roles, que solo sirve en los endpoints marcados con
   * `@AllowRestrictedSession(...)` para su alcance:
   * - `support`: cuenta deshabilitada (sus tickets y pedir su eliminación);
   * - `deletion`: cuenta pendiente de eliminación (consultar o cancelar la eliminación).
   */
  restricted?: RestrictedScope;
}

export type AuthenticatedRequest = Request & { user?: AuthUser };

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new Error('CurrentUser usado en un endpoint sin autenticación');
    return user;
  },
);

/** En endpoints `@Public()`: la cuenta si la petición trae una sesión válida; si no, null. */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | null =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user ?? null,
);
