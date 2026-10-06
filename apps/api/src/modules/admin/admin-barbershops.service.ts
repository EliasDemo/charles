import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { type Page, pageArgs, toPage } from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { BarbershopStatus, BookingStatus } from '../../generated/prisma/enums';
import { BookingStateMachine } from '../bookings/booking-state-machine';
import { BOOKING_TX_OPTIONS } from '../bookings/bookings.service';
import { PaymentsService } from '../payments/payments.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { SUPPORT_DEFAULTS } from '../support/support-policy';
import { ConflictOfInterestService, type StaffActor } from './admin-access';
import type {
  AdminBarbershopDetailDto,
  AdminBarbershopDto,
  AdminBarbershopQueryDto,
  SuspendBarbershopDto,
  SuspensionResultDto,
} from './dto/admin.dto';

export const BARBERSHOP_SUSPENDED_EVENT = 'barbershop.suspended';

/** Qué hacer con las reservas futuras al suspender (las pendientes de pago se cancelan siempre). */
export type SuspensionMode = 'KEEP_UPCOMING' | 'CANCEL_ALL' | 'KEEP_ALL';

const shopNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La barbería no existe.', HttpStatus.NOT_FOUND);

const statusConflict = (from: BarbershopStatus, to: BarbershopStatus): AppException =>
  new AppException(
    ErrorCode.STATUS_CHANGE_NOT_ALLOWED,
    'Ese cambio de estado no aplica a la barbería en su estado actual.',
    HttpStatus.CONFLICT,
    [{ from, to }],
  );

/**
 * Decide qué reservas se cancelan al suspender. Función pura.
 * - `PENDING_PAYMENT`: siempre.
 * - `CONFIRMED` futuras: `CANCEL_ALL` todas; `KEEP_ALL` ninguna; `KEEP_UPCOMING` (por defecto)
 *   las que empiezan después de `keepHours`.
 */
export function suspensionCancels(
  booking: { status: BookingStatus; startAt: number },
  mode: SuspensionMode,
  nowMs: number,
  keepHours: number,
): boolean {
  if (booking.status === 'PENDING_PAYMENT') return true;
  if (booking.status !== 'CONFIRMED' || booking.startAt <= nowMs) return false;
  if (mode === 'CANCEL_ALL') return true;
  if (mode === 'KEEP_ALL') return false;
  return booking.startAt > nowMs + keepHours * 3600_000;
}

/** Barberías (RF-OPE-002, Fase 12): revisión, suspensión, reactivación y reportes. */
@Injectable()
export class AdminBarbershopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: BookingStateMachine,
    private readonly payments: PaymentsService,
    private readonly settings: SettingsService,
    private readonly conflicts: ConflictOfInterestService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Por defecto, las que necesitan atención: con reportes abiertos, marcadas por el sistema o
   * pendientes de revisión. `status` filtra por estado.
   */
  async list(query: AdminBarbershopQueryDto): Promise<Page<AdminBarbershopDto>> {
    const args = pageArgs(query);
    const rows = await this.prisma.barbershop.findMany({
      where: {
        ...args.where,
        deletedAt: null,
        ...(query.status
          ? { status: query.status }
          : {
              OR: [
                { reports: { some: { status: { not: 'RESOLVED' } } } },
                { flaggedReason: { not: null } },
                { status: 'PENDING_REVIEW' },
              ],
            }),
      },
      orderBy: args.orderBy,
      take: args.take,
      include: { _count: { select: { reports: { where: { status: { not: 'RESOLVED' } } } } } },
    });
    return toPage(rows, query, (b) => ({
      id: b.id,
      name: b.name,
      status: b.status,
      type: b.type,
      flaggedReason: b.flaggedReason,
      flaggedAt: b.flaggedAt?.toISOString() ?? null,
      openReports: b._count.reports,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  async get(staff: StaffActor, barbershopId: string): Promise<AdminBarbershopDetailDto> {
    await this.conflicts.assertNotMember(staff, barbershopId);
    const shop = await this.prisma.barbershop.findFirst({
      where: { id: barbershopId, deletedAt: null },
      include: {
        reports: {
          where: { status: { not: 'RESOLVED' } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, reason: true, details: true, createdAt: true },
        },
      },
    });
    if (!shop) throw shopNotFound();
    return {
      id: shop.id,
      name: shop.name,
      status: shop.status,
      type: shop.type,
      flaggedReason: shop.flaggedReason,
      flaggedAt: shop.flaggedAt?.toISOString() ?? null,
      openReports: shop.reports.length,
      createdAt: shop.createdAt.toISOString(),
      reports: shop.reports.map((r) => ({
        id: r.id,
        reason: r.reason,
        details: r.details,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /** `PENDING_REVIEW` → `OPEN`. */
  async approve(
    staff: StaffActor,
    barbershopId: string,
    reason: string,
  ): Promise<AdminBarbershopDetailDto> {
    await this.changeStatus(staff, barbershopId, ['PENDING_REVIEW'], 'OPEN', reason);
    return this.get(staff, barbershopId);
  }

  /** `SUSPENDED` → `OPEN`. Quita la marca del sistema. */
  async reactivate(
    staff: StaffActor,
    barbershopId: string,
    reason: string,
  ): Promise<AdminBarbershopDetailDto> {
    await this.changeStatus(staff, barbershopId, ['SUSPENDED'], 'OPEN', reason);
    return this.get(staff, barbershopId);
  }

  /**
   * Suspender, con la decisión sobre las reservas futuras. Todo en una transacción: estado,
   * cancelaciones (por soporte, con devolución total que ejecuta el outbox), auditoría y el evento
   * `barbershop.suspended`. Cada reserva cancelada publica `booking.cancelled` con rol SUPPORT.
   */
  async suspend(
    staff: StaffActor,
    barbershopId: string,
    dto: SuspendBarbershopDto,
  ): Promise<SuspensionResultDto> {
    await this.conflicts.assertNotMember(staff, barbershopId);
    const mode: SuspensionMode = dto.bookings ?? 'KEEP_UPCOMING';
    const keepHours = await this.settings.positiveInt(
      SettingKey.SUPPORT_SUSPENSION_KEEP_HOURS,
      SUPPORT_DEFAULTS.suspensionKeepHours,
    );
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const [shop] = await tx.$queryRaw<{ status: BarbershopStatus }[]>`
        SELECT status FROM barbershops
         WHERE id = ${barbershopId}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (!shop) throw shopNotFound();
      if (shop.status === 'SUSPENDED') throw statusConflict(shop.status, 'SUSPENDED');
      await tx.barbershop.update({ where: { id: barbershopId }, data: { status: 'SUSPENDED' } });

      // Bloqueo ordenado por id (como en reservas) para no chocar con cancelaciones simultáneas.
      const bookings = await tx.$queryRaw<
        { id: string; status: BookingStatus; start_at: Date }[]
      >`SELECT id::text AS id, status, start_at FROM bookings
         WHERE barbershop_id = ${barbershopId}::uuid
           AND status IN ('PENDING_PAYMENT', 'CONFIRMED')
         ORDER BY id FOR UPDATE`;
      const actor = { userId: staff.id, role: 'SUPPORT' as const };
      let cancelled = 0;
      let kept = 0;
      for (const booking of bookings) {
        if (
          !suspensionCancels(
            { status: booking.status, startAt: booking.start_at.getTime() },
            mode,
            now,
            keepHours,
          )
        ) {
          if (booking.status === 'CONFIRMED' && booking.start_at.getTime() > now) kept++;
          continue;
        }
        await this.stateMachine.transition(
          tx,
          booking.id,
          'CANCELLED',
          actor,
          `barbershop_suspended: ${dto.reason}`,
        );
        await this.payments.onBookingCancelled(
          tx,
          { id: booking.id, startAt: booking.start_at },
          'SUPPORT',
        );
        cancelled++;
      }
      await this.outbox.publish(tx, BARBERSHOP_SUSPENDED_EVENT, {
        barbershopId,
        mode,
        cancelledBookings: cancelled,
      });
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'barbershop.suspended',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: {
            values: { status: { from: shop.status, to: 'SUSPENDED' } },
            reason: dto.reason,
            mode,
            keepHours,
            cancelledBookings: cancelled,
            keptBookings: kept,
            actorRole: staff.role,
          },
        },
        tx,
      );
      return {
        status: 'SUSPENDED' as const,
        mode,
        cancelledBookings: cancelled,
        keptBookings: kept,
      };
    }, BOOKING_TX_OPTIONS);
  }

  /** Resuelve todos los reportes abiertos de la barbería y quita la marca del sistema. */
  async resolveReports(
    staff: StaffActor,
    barbershopId: string,
    resolution: string,
  ): Promise<AdminBarbershopDetailDto> {
    await this.conflicts.assertNotMember(staff, barbershopId);
    await this.prisma.$transaction(async (tx) => {
      const shop = await tx.barbershop.findFirst({
        where: { id: barbershopId, deletedAt: null },
        select: { flaggedReason: true },
      });
      if (!shop) throw shopNotFound();
      const { count } = await tx.barbershopReport.updateMany({
        where: { barbershopId, status: { not: 'RESOLVED' } },
        data: {
          status: 'RESOLVED',
          resolution,
          resolvedById: staff.id,
          resolvedAt: new Date(this.clock.now()),
        },
      });
      await tx.barbershop.update({
        where: { id: barbershopId },
        data: { flaggedReason: null, flaggedAt: null },
      });
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'barbershop.reports_resolved',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: {
            resolvedReports: count,
            clearedFlag: shop.flaggedReason,
            resolution,
            actorRole: staff.role,
          },
        },
        tx,
      );
    });
    return this.get(staff, barbershopId);
  }

  private async changeStatus(
    staff: StaffActor,
    barbershopId: string,
    from: BarbershopStatus[],
    to: BarbershopStatus,
    reason: string,
  ): Promise<void> {
    await this.conflicts.assertNotMember(staff, barbershopId);
    await this.prisma.$transaction(async (tx) => {
      const [shop] = await tx.$queryRaw<{ status: BarbershopStatus }[]>`
        SELECT status FROM barbershops
         WHERE id = ${barbershopId}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (!shop) throw shopNotFound();
      if (!from.includes(shop.status)) throw statusConflict(shop.status, to);
      await tx.barbershop.update({
        where: { id: barbershopId },
        data: { status: to, ...(to === 'OPEN' ? { flaggedReason: null, flaggedAt: null } : {}) },
      });
      await this.audit.record(
        {
          actorId: staff.id,
          action:
            to === 'OPEN' && shop.status === 'PENDING_REVIEW'
              ? 'barbershop.approved'
              : 'barbershop.reactivated',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: {
            values: { status: { from: shop.status, to } },
            reason,
            actorRole: staff.role,
          },
        },
        tx,
      );
    });
  }
}
