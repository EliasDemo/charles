import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { MfaService } from '../auth/mfa/mfa.service';
import { SessionsService } from '../auth/sessions.service';
import { type StaffUserView, UsersService } from '../users/users.service';
import { ConflictOfInterestService, type StaffActor } from './admin-access';

export const USER_DISABLED_EVENT = 'user.disabled';
export const OWNER_DISABLED_FLAG = 'owner_disabled';
export type ManagedRole = 'SUPPORT' | 'ADMIN';

const userNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La cuenta no existe.', HttpStatus.NOT_FOUND);

const forbidden = (message: string): AppException =>
  new AppException(ErrorCode.FORBIDDEN, message, HttpStatus.FORBIDDEN);

const lastAdmin = (): AppException =>
  new AppException(
    ErrorCode.LAST_ADMIN,
    'Debe quedar al menos otra cuenta ADMIN activa.',
    HttpStatus.CONFLICT,
  );

/**
 * Cuentas (RF-OPE-001, Fase 12). Soporte ve solo datos mínimos; el contacto se pide aparte, con
 * motivo, y cada acceso queda auditado. Nadie actúa sobre su propia cuenta. Siempre queda al menos
 * una cuenta ADMIN activa.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly conflicts: ConflictOfInterestService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly mfa: MfaService,
  ) {}

  /**
   * Búsqueda exacta por correo (índice ciego) o por nombre de usuario. La auditoría no guarda lo
   * buscado.
   */
  async find(
    staff: StaffActor,
    query: { email?: string; username?: string },
  ): Promise<StaffUserView> {
    if (!query.email && !query.username) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'email', constraints: ['emailOrUsername'] }],
      );
    }
    const id = query.email
      ? await this.users.findIdByEmailHash(this.users.emailHash(query.email))
      : ((await this.users.findCredentialsByUsername(query.username!))?.id ?? null);
    await this.audit.record({
      actorId: staff.id,
      action: 'user.looked_up',
      entityType: 'user',
      entityId: id,
      changes: { found: id !== null, actorRole: staff.role },
    });
    if (!id) throw userNotFound();
    return this.get(staff, id);
  }

  async get(staff: StaffActor, userId: string): Promise<StaffUserView> {
    this.conflicts.assertNotSelf(staff, userId);
    const user = await this.users.staffView(userId);
    if (!user) throw userNotFound();
    return user;
  }

  /** Contacto en claro: motivo obligatorio y, si corresponde, el ticket de esa cuenta. Auditado. */
  async contact(
    staff: StaffActor,
    userId: string,
    reason: string,
    ticketId?: string,
  ): Promise<{ email: string; phone: string | null }> {
    this.conflicts.assertNotSelf(staff, userId);
    if (ticketId) {
      const ticket = await this.prisma.supportTicket.findUnique({
        where: { id: ticketId },
        select: { userId: true },
      });
      if (ticket?.userId !== userId) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'El ticket no pertenece a esa cuenta.',
          HttpStatus.BAD_REQUEST,
          [{ field: 'ticketId', constraints: ['ticketOfUser'] }],
        );
      }
    }
    const contact = await this.users.contact(userId);
    if (!contact) throw userNotFound();
    await this.audit.record({
      actorId: staff.id,
      action: 'user.contact_viewed',
      entityType: 'user',
      entityId: userId,
      changes: { reason, ticketId: ticketId ?? null, actorRole: staff.role },
    });
    return contact;
  }

  /**
   * Deshabilitar: revoca todas sus sesiones al instante; sus reservas se mantienen; las barberías
   * donde era el único OWNER siguen, marcadas para revisión. Soporte no deshabilita cuentas de
   * soporte ni ADMIN. Publica `user.disabled` (el aviso llega con la Fase 10).
   */
  async disable(staff: StaffActor, userId: string, reason: string): Promise<StaffUserView> {
    this.conflicts.assertNotSelf(staff, userId);
    const target = await this.users.findCredentialsById(userId);
    if (!target || target.isDeleted) throw userNotFound();
    const privileged = target.roles.some((r) => r === 'SUPPORT' || r === 'ADMIN');
    if (privileged && staff.role !== 'ADMIN') {
      throw forbidden('Solo ADMIN puede deshabilitar cuentas de soporte o ADMIN.');
    }
    const sessionIds = await this.prisma.$transaction(async (tx) => {
      await this.lockRoles(tx);
      const current = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { status: true },
      });
      if (current.status === 'DISABLED') {
        throw new AppException(
          ErrorCode.CONFLICT,
          'La cuenta ya está deshabilitada.',
          HttpStatus.CONFLICT,
        );
      }
      if (
        target.roles.includes('ADMIN') &&
        (await this.users.countActiveWithRole('ADMIN', userId, tx)) === 0
      ) {
        throw lastAdmin();
      }
      await this.users.setStatus(userId, 'DISABLED', tx);
      const revoked = await this.sessions.revokeAllForUser(userId, tx);
      const flagged = await this.flagSoleOwnedBarbershops(tx, userId);
      await this.outbox.publish(tx, USER_DISABLED_EVENT, { userId });
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'user.disabled',
          entityType: 'user',
          entityId: userId,
          changes: {
            values: { status: { from: 'ACTIVE', to: 'DISABLED' } },
            reason,
            actorRole: staff.role,
            flaggedBarbershops: flagged,
          },
        },
        tx,
      );
      return revoked;
    });
    await this.sessions.markRevoked(sessionIds);
    return (await this.users.staffView(userId))!;
  }

  async enable(staff: StaffActor, userId: string, reason: string): Promise<StaffUserView> {
    this.conflicts.assertNotSelf(staff, userId);
    const target = await this.users.findCredentialsById(userId);
    if (!target || target.isDeleted) throw userNotFound();
    const privileged = target.roles.some((r) => r === 'SUPPORT' || r === 'ADMIN');
    if (privileged && staff.role !== 'ADMIN') {
      throw forbidden('Solo ADMIN puede reactivar cuentas de soporte o ADMIN.');
    }
    if (target.status === 'ACTIVE') {
      throw new AppException(ErrorCode.CONFLICT, 'La cuenta ya está activa.', HttpStatus.CONFLICT);
    }
    await this.prisma.$transaction(async (tx) => {
      await this.users.setStatus(userId, 'ACTIVE', tx);
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'user.enabled',
          entityType: 'user',
          entityId: userId,
          changes: {
            values: { status: { from: 'DISABLED', to: 'ACTIVE' } },
            reason,
            actorRole: staff.role,
          },
        },
        tx,
      );
    });
    return (await this.users.staffView(userId))!;
  }

  /**
   * Solo ADMIN. Reinicia el segundo factor de alguien que perdió el teléfono y los códigos: lo
   * borra y cierra sus sesiones; deberá activarlo de nuevo. Nunca sobre la propia cuenta.
   */
  async resetMfa(staff: StaffActor, userId: string, reason: string): Promise<StaffUserView> {
    this.conflicts.assertNotSelf(staff, userId);
    const target = await this.users.findCredentialsById(userId);
    if (!target || target.isDeleted) throw userNotFound();
    const sessionIds = await this.prisma.$transaction(async (tx) => {
      const had = await tx.userMfa.count({ where: { userId } });
      if (!had) {
        throw new AppException(
          ErrorCode.MFA_NOT_ENABLED,
          'La cuenta no tiene verificación en dos pasos.',
          HttpStatus.CONFLICT,
        );
      }
      const ids = await this.mfa.resetFor(tx, userId);
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'mfa.reset',
          entityType: 'user',
          entityId: userId,
          changes: { reason, actorRole: staff.role },
        },
        tx,
      );
      return ids;
    });
    await this.sessions.markRevoked(sessionIds);
    return (await this.users.staffView(userId))!;
  }

  /** Solo ADMIN. Asignar SUPPORT o ADMIN a una cuenta activa. */
  async grantRole(
    staff: StaffActor,
    userId: string,
    role: ManagedRole,
    reason: string,
  ): Promise<StaffUserView> {
    this.conflicts.assertNotSelf(staff, userId);
    const target = await this.users.findCredentialsById(userId);
    if (!target || target.isDeleted) throw userNotFound();
    if (target.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCode.CONFLICT,
        'No se asignan roles a una cuenta deshabilitada.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await this.users.addRole(userId, role, tx);
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'role.granted',
          entityType: 'user',
          entityId: userId,
          changes: { role, reason, actorRole: staff.role, via: 'admin' },
        },
        tx,
      );
    });
    return (await this.users.staffView(userId))!;
  }

  /** Solo ADMIN. Nadie se quita a sí mismo; nunca se quita el rol al último ADMIN activo. */
  async revokeRole(
    staff: StaffActor,
    userId: string,
    role: ManagedRole,
    reason: string,
  ): Promise<StaffUserView> {
    this.conflicts.assertNotSelf(staff, userId);
    const target = await this.users.findCredentialsById(userId);
    if (!target || target.isDeleted) throw userNotFound();
    await this.prisma.$transaction(async (tx) => {
      await this.lockRoles(tx);
      if (role === 'ADMIN' && (await this.users.countActiveWithRole('ADMIN', userId, tx)) === 0) {
        throw lastAdmin();
      }
      await this.users.removeRole(userId, role, tx);
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'role.revoked',
          entityType: 'user',
          entityId: userId,
          changes: { role, reason, actorRole: staff.role },
        },
        tx,
      );
    });
    return (await this.users.staffView(userId))!;
  }

  /** Serializa los cambios que afectan a las cuentas ADMIN (regla del último ADMIN). */
  private async lockRoles(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin:roles'))`;
  }

  /** Barberías activas donde la cuenta es el único OWNER: quedan marcadas para revisión. */
  private async flagSoleOwnedBarbershops(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT m.barbershop_id::text AS id
        FROM barbershop_members m
        JOIN barbershops b ON b.id = m.barbershop_id AND b.deleted_at IS NULL
       WHERE m.user_id = ${userId}::uuid AND m.role = 'OWNER'
         AND NOT EXISTS (
           SELECT 1 FROM barbershop_members o
            WHERE o.barbershop_id = m.barbershop_id AND o.role = 'OWNER' AND o.user_id <> m.user_id
         )`;
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await tx.barbershop.updateMany({
        where: { id: { in: ids }, flaggedReason: null },
        data: { flaggedReason: OWNER_DISABLED_FLAG, flaggedAt: new Date(this.clock.now()) },
      });
    }
    return ids;
  }
}
