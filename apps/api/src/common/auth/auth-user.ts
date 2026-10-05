import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '../../generated/prisma/enums';

/** Usuario autenticado: siempre sale del token verificado, nunca del cuerpo de la petición. */
export interface AuthUser {
  id: string;
  roles: Role[];
  /** Familia de sesión (`refresh_tokens.family_id`). */
  sessionId: string;
}

export type AuthenticatedRequest = Request & { user?: AuthUser };

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new Error('CurrentUser usado en un endpoint sin autenticación');
    return user;
  },
);
