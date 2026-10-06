import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../../common/auth/auth-user';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Role } from '../../generated/prisma/enums';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { UsersService } from '../users/users.service';

export const ADMIN_ACCESS_KEY = 'adminAccess';
type AdminAccess = 'SUPPORT_OR_ADMIN' | 'ADMIN';

/** Soporte o administración (prefijo `/admin`). Va en la clase del controlador. */
export const SupportOrAdmin = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_ACCESS_KEY, 'SUPPORT_OR_ADMIN' satisfies AdminAccess);

/** Solo ADMIN (roles, ajustes, categorías, reembolso manual). Va en el método. */
export const AdminOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_ACCESS_KEY, 'ADMIN' satisfies AdminAccess);

/** Quién actúa en `/admin`, con sus roles **leídos de la base** en esta petición. */
export interface StaffActor {
  id: string;
  roles: Role[];
  /** Rol con el que actúa, para la auditoría: ADMIN si lo tiene, si no SUPPORT. */
  role: 'ADMIN' | 'SUPPORT';
}

type StaffRequest = AuthenticatedRequest & { staff?: StaffActor };

export const CurrentStaff = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const staff = ctx.switchToHttp().getRequest<StaffRequest>().staff;
  if (!staff) throw new Error('CurrentStaff usado sin AdminAccessGuard');
  return staff;
});

const forbidden = (): AppException =>
  new AppException(
    ErrorCode.FORBIDDEN,
    'No tienes permiso para realizar esta acción.',
    HttpStatus.FORBIDDEN,
  );

/**
 * Autorización de `/admin` (Fase 12). No confía en los roles del JWT (pueden tener hasta 15 min):
 * relee de la base los roles y el estado de la cuenta en cada petición. Un rol quitado o una
 * cuenta deshabilitada pierden el acceso al instante. Corre después de la autenticación.
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<AdminAccess | undefined>(ADMIN_ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<StaffRequest>();
    const userId = request.user?.id;
    if (!required || !userId) throw forbidden();
    const user = await this.users.findCredentialsById(userId);
    if (!user || user.isDeleted || user.status !== 'ACTIVE') throw forbidden();
    const isAdmin = user.roles.includes('ADMIN');
    const allowed = required === 'ADMIN' ? isAdmin : isAdmin || user.roles.includes('SUPPORT');
    if (!allowed) throw forbidden();
    request.staff = { id: user.id, roles: user.roles, role: isAdmin ? 'ADMIN' : 'SUPPORT' };
    return true;
  }
}

export const conflictOfInterest = (): AppException =>
  new AppException(
    ErrorCode.CONFLICT_OF_INTEREST,
    'No puedes actuar sobre tu propia cuenta ni sobre una barbería de la que eres miembro.',
    HttpStatus.FORBIDDEN,
  );

/**
 * Regla de conflicto de interés (Fase 12): soporte y ADMIN nunca actúan sobre su propia cuenta ni
 * sobre una barbería de la que son miembros. Se comprueba en cada acción.
 */
@Injectable()
export class ConflictOfInterestService {
  constructor(private readonly access: BarbershopAccessService) {}

  assertNotSelf(staff: StaffActor, userId: string | null | undefined): void {
    if (userId && userId === staff.id) throw conflictOfInterest();
  }

  async assertNotMember(staff: StaffActor, barbershopId: string): Promise<void> {
    if (await this.access.isMember(barbershopId, staff.id)) throw conflictOfInterest();
  }

  /** Reserva, pago o valoración: ni el cliente ni la barbería pueden ser quien actúa. */
  async assertUninvolved(
    staff: StaffActor,
    involved: { userId?: string | null; barbershopId?: string | null },
  ): Promise<void> {
    this.assertNotSelf(staff, involved.userId);
    if (involved.barbershopId) await this.assertNotMember(staff, involved.barbershopId);
  }
}
