import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '../../generated/prisma/enums';

/** Usuario autenticado: siempre sale del token verificado, nunca del cuerpo de la petición. */
export interface AuthUser {
  id: string;
  roles: Role[];
  /** Familia de sesión (`refresh_tokens.family_id`). */
  sessionId: string;
  /**
   * Fase 12: sesión restringida de una cuenta deshabilitada. Solo sirve en los endpoints marcados
   * con `@AllowRestrictedSession()` (tickets de soporte propios); sin roles.
   */
  restricted?: true;
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
