import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { BarbershopMemberRole, BarbershopStatus } from '../../generated/prisma/enums';

/** Estados visibles públicamente. PENDING_REVIEW y SUSPENDED nunca aparecen en consultas públicas. */
export const PUBLIC_STATUSES: BarbershopStatus[] = ['OPEN', 'TEMPORARILY_CLOSED'];

export const publicBarbershopWhere = (id: string): Prisma.BarbershopWhereInput => ({
  id,
  deletedAt: null,
  status: { in: PUBLIC_STATUSES },
});

export const notFound = (): AppException =>
  new AppException(
    ErrorCode.NOT_FOUND,
    'La barbería no existe o no tienes acceso a ella.',
    HttpStatus.NOT_FOUND,
  );

export const forbidden = (): AppException =>
  new AppException(
    ErrorCode.FORBIDDEN,
    'No tienes permiso para realizar esta acción.',
    HttpStatus.FORBIDDEN,
  );

export interface Membership {
  barbershopId: string;
  userId: string;
  role: BarbershopMemberRole;
}

/**
 * Verificación de propiedad (CLAUDE.md §6.4): el rol global OWNER no basta; hay que ser
 * miembro de ESA barbería. Para no revelar barberías ajenas, un no miembro recibe 404.
 */
@Injectable()
export class BarbershopAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async requireMember(
    userId: string,
    barbershopId: string,
    allowedRoles: BarbershopMemberRole[] = ['OWNER', 'MANAGER'],
  ): Promise<Membership> {
    const membership = await this.prisma.barbershopMember.findFirst({
      where: { barbershopId, userId, barbershop: { deletedAt: null } },
      select: { barbershopId: true, userId: true, role: true },
    });
    if (!membership) throw notFound();
    if (!allowedRoles.includes(membership.role)) throw forbidden();
    return membership;
  }

  async isMember(barbershopId: string, userId: string): Promise<boolean> {
    return (await this.prisma.barbershopMember.count({ where: { barbershopId, userId } })) > 0;
  }

  /** Nombres de barberías no eliminadas (para invitaciones y correos). */
  async names(ids: string[]): Promise<Map<string, string>> {
    const shops = await this.prisma.barbershop.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true },
    });
    return new Map(shops.map((s) => [s.id, s.name]));
  }

  /**
   * Zona horaria y estado de varias barberías visibles (para el motor de disponibilidad, por lotes).
   * Las no visibles no aparecen en el resultado.
   */
  async publicScheduleInfo(
    ids: string[],
  ): Promise<Map<string, { timezone: string; status: BarbershopStatus }>> {
    const shops = await this.prisma.barbershop.findMany({
      where: { id: { in: ids }, deletedAt: null, status: { in: PUBLIC_STATUSES } },
      select: { id: true, timezone: true, status: true },
    });
    return new Map(shops.map((s) => [s.id, { timezone: s.timezone, status: s.status }]));
  }

  /** Ubicación y zona de una barbería visible (alternativas, Fase 6); null si no es visible. */
  async publicLocation(
    id: string,
  ): Promise<{ latitude: number; longitude: number; timezone: string } | null> {
    return this.prisma.barbershop.findFirst({
      where: publicBarbershopWhere(id),
      select: { latitude: true, longitude: true, timezone: true },
    });
  }

  async timezoneOf(id: string): Promise<string> {
    const shop = await this.prisma.barbershop.findUniqueOrThrow({
      where: { id },
      select: { timezone: true },
    });
    return shop.timezone;
  }

  /** 404 si la barbería no es visible públicamente. */
  async requirePublic(barbershopId: string): Promise<void> {
    const visible = await this.prisma.barbershop.count({
      where: publicBarbershopWhere(barbershopId),
    });
    if (visible === 0) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La barbería no existe.', HttpStatus.NOT_FOUND);
    }
  }
}
