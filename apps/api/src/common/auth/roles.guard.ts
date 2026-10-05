import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../../generated/prisma/enums';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import type { AuthenticatedRequest } from './auth-user';
import { ROLES_KEY } from './roles.decorator';

/** Exige alguno de los roles de `@Roles()`. La propiedad del recurso se verifica en cada servicio. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (user && required.some((role) => user.roles.includes(role))) return true;

    throw new AppException(
      ErrorCode.FORBIDDEN,
      'No tienes permiso para realizar esta acción.',
      HttpStatus.FORBIDDEN,
    );
  }
}
