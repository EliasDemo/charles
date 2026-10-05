import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  type Page,
  type PaginationQueryDto,
  pageArgs,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { BarbershopMemberRole } from '../../generated/prisma/enums';
import { UsersService } from '../users/users.service';
import { BarbershopAccessService, forbidden } from './barbershop-access.service';
import type { MemberDto } from './dto/member.dto';

const lastOwner = (): AppException =>
  new AppException(
    ErrorCode.LAST_OWNER,
    'La barbería debe tener siempre al menos un responsable OWNER. Nombra otro OWNER antes.',
    HttpStatus.CONFLICT,
  );

const memberNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El responsable no existe.', HttpStatus.NOT_FOUND);

/**
 * Responsables de una barbería (CLAUDE.md §4.1). Regla: siempre al menos un OWNER.
 * Las operaciones que pueden quitar un OWNER bloquean la fila de la barbería (FOR UPDATE)
 * para que dos cambios simultáneos no la dejen sin OWNER.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  async list(
    userId: string,
    barbershopId: string,
    query: PaginationQueryDto,
  ): Promise<Page<MemberDto>> {
    await this.access.requireMember(userId, barbershopId);
    const args = pageArgs(query);
    const rows = await this.prisma.barbershopMember.findMany({
      where: { barbershopId, ...args.where },
      orderBy: args.orderBy,
      take: args.take,
    });
    const names = await this.users.fullNames(rows.map((r) => r.userId));
    return toPage(rows, query, (m) => ({
      userId: m.userId,
      fullName: names.get(m.userId) ?? '',
      role: m.role,
      since: m.createdAt,
    }));
  }

  /** Solo un OWNER cambia roles. Degradar al último OWNER se rechaza (incluso a sí mismo). */
  async changeRole(
    actorId: string,
    barbershopId: string,
    targetUserId: string,
    role: BarbershopMemberRole,
    ip: string | null,
  ): Promise<void> {
    await this.access.requireMember(actorId, barbershopId, ['OWNER']);
    await this.prisma.$transaction(async (tx) => {
      await this.lockBarbershop(tx, barbershopId);
      const target = await tx.barbershopMember.findUnique({
        where: { barbershopId_userId: { barbershopId, userId: targetUserId } },
      });
      if (!target) throw memberNotFound();
      if (target.role === role) return;
      if (target.role === 'OWNER' && (await this.ownerCount(tx, barbershopId)) <= 1)
        throw lastOwner();

      await tx.barbershopMember.update({ where: { id: target.id }, data: { role } });
      await this.audit.record(
        {
          actorId,
          action: 'barbershop.member_role_changed',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: { userId: targetUserId, values: { role: { from: target.role, to: role } } },
          ip,
        },
        tx,
      );
    });
  }

  /**
   * Un OWNER puede quitar a cualquier responsable; cualquier responsable puede retirarse a sí
   * mismo. Nunca se puede quitar al último OWNER.
   */
  async remove(
    actorId: string,
    barbershopId: string,
    targetUserId: string,
    ip: string | null,
  ): Promise<void> {
    const actor = await this.access.requireMember(actorId, barbershopId);
    if (actorId !== targetUserId && actor.role !== 'OWNER') throw forbidden();

    await this.prisma.$transaction(async (tx) => {
      await this.lockBarbershop(tx, barbershopId);
      const target = await tx.barbershopMember.findUnique({
        where: { barbershopId_userId: { barbershopId, userId: targetUserId } },
      });
      if (!target) throw memberNotFound();
      if (target.role === 'OWNER' && (await this.ownerCount(tx, barbershopId)) <= 1)
        throw lastOwner();

      await tx.barbershopMember.delete({ where: { id: target.id } });
      await this.syncOwnerRole(targetUserId, tx);
      await this.audit.record(
        {
          actorId,
          action: 'barbershop.member_removed',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: { userId: targetUserId, values: { role: { from: target.role, to: null } } },
          ip,
        },
        tx,
      );
    });
  }

  /** Agrega un responsable (al aceptar una invitación). */
  async addFromInvitation(
    tx: Prisma.TransactionClient,
    barbershopId: string,
    userId: string,
    role: BarbershopMemberRole,
    invitedById: string,
  ): Promise<void> {
    await this.lockBarbershop(tx, barbershopId);
    const existing = await tx.barbershopMember.findUnique({
      where: { barbershopId_userId: { barbershopId, userId } },
    });
    if (existing) {
      throw new AppException(
        ErrorCode.ALREADY_MEMBER,
        'Ya eres responsable de esta barbería.',
        HttpStatus.CONFLICT,
      );
    }
    await tx.barbershopMember.create({ data: { barbershopId, userId, role } });
    await this.users.addRole(userId, 'OWNER', tx);
    await this.audit.record(
      {
        actorId: userId,
        action: 'barbershop.member_added',
        entityType: 'barbershop',
        entityId: barbershopId,
        changes: { userId, invitedBy: invitedById, values: { role: { from: null, to: role } } },
      },
      tx,
    );
  }

  /**
   * Rol global OWNER ("responsable de barbería"): lo tiene quien es miembro (OWNER o MANAGER) de
   * al menos una barbería no eliminada; si deja de serlo, se retira.
   */
  async syncOwnerRole(userId: string, tx: Prisma.TransactionClient): Promise<void> {
    const memberships = await tx.barbershopMember.count({
      where: { userId, barbershop: { deletedAt: null } },
    });
    if (memberships > 0) await this.users.addRole(userId, 'OWNER', tx);
    else await this.users.removeRole(userId, 'OWNER', tx);
  }

  /** Al eliminar una barbería: recalcula el rol de todos sus responsables. */
  async syncOwnerRolesOf(barbershopId: string, tx: Prisma.TransactionClient): Promise<void> {
    const members = await tx.barbershopMember.findMany({
      where: { barbershopId },
      select: { userId: true },
    });
    for (const { userId } of members) await this.syncOwnerRole(userId, tx);
  }

  private async lockBarbershop(tx: Prisma.TransactionClient, barbershopId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM barbershops WHERE id = ${barbershopId}::uuid FOR UPDATE`;
  }

  private ownerCount(tx: Prisma.TransactionClient, barbershopId: string): Promise<number> {
    return tx.barbershopMember.count({ where: { barbershopId, role: 'OWNER' } });
  }
}
