import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { DEFAULT_PAGE_SIZE, type Page } from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { BarbershopStatus, BookingStatus } from '../../generated/prisma/enums';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
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
export const BARBERSHOP_REVIEW_APPROVED_EVENT = 'barbershop.review_approved';
export const BARBERSHOP_REVIEW_CHANGES_REQUESTED_EVENT = 'barbershop.review_changes_requested';

interface QueueRow {
  id: string;
  name: string;
  status: string;
  type: string;
  flagged_reason: string | null;
  flagged_at: Date | null;
  created_at: Date;
  submitted_for_review_at: Date | null;
  owner_document_type: string | null;
  open_reports: number;
  waiting_since: Date;
}

/** Cursor opaco de la cola: (espera, id). */
function encodeQueueCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.getTime(), id])).toString('base64url');
}

function decodeQueueCursor(cursor: string): { at: Date; id: string } {
  try {
    const [ms, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (typeof ms === 'number' && typeof id === 'string') return { at: new Date(ms), id };
  } catch {
    // cae al error de abajo
  }
  throw new AppException(
    ErrorCode.INVALID_CURSOR,
    'El cursor no es válido. Vuelve a la primera página.',
    HttpStatus.BAD_REQUEST,
  );
}

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
    private readonly encryption: EncryptionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Por defecto, las que necesitan atención: envíos pendientes de revisión, marcadas por el
   * sistema (p. ej. documento modificado) o con reportes abiertos. `status` filtra por estado.
   * Ordenadas por **antigüedad de la espera** (`waitingSince`), la más antigua primero.
   */
  async list(query: AdminBarbershopQueryDto): Promise<Page<AdminBarbershopDto>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const after = query.cursor ? decodeQueueCursor(query.cursor) : null;
    const filter = query.status
      ? Prisma.sql`b.status = ${query.status}::"BarbershopStatus"`
      : Prisma.sql`(b.status = 'PENDING_REVIEW' OR b.flagged_reason IS NOT NULL OR r.open_reports > 0)`;
    const rows = await this.prisma.$queryRaw<QueueRow[]>`
      SELECT * FROM (
        SELECT b.id::text AS id, b.name, b.status::text AS status, b.type::text AS type,
               b.flagged_reason, b.flagged_at, b.created_at, b.submitted_for_review_at,
               b.owner_document_type::text AS owner_document_type,
               COALESCE(r.open_reports, 0)::int AS open_reports,
               COALESCE(b.submitted_for_review_at, b.flagged_at, r.oldest_report, b.created_at)
                 AS waiting_since
          FROM barbershops b
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS open_reports, MIN(created_at) AS oldest_report
              FROM barbershop_reports rp
             WHERE rp.barbershop_id = b.id AND rp.status <> 'RESOLVED') r ON true
         WHERE b.deleted_at IS NULL AND ${filter}
      ) q
      WHERE ${after ? Prisma.sql`(q.waiting_since, q.id) > (${after.at}, ${after.id})` : Prisma.sql`true`}
      ORDER BY q.waiting_since, q.id
      LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((b) => ({
        id: b.id,
        name: b.name,
        status: b.status as BarbershopStatus,
        type: b.type as AdminBarbershopDto['type'],
        flaggedReason: b.flagged_reason,
        flaggedAt: b.flagged_at?.toISOString() ?? null,
        openReports: b.open_reports,
        createdAt: b.created_at.toISOString(),
        submittedForReviewAt: b.submitted_for_review_at?.toISOString() ?? null,
        ownerDocumentType: b.owner_document_type as AdminBarbershopDto['ownerDocumentType'],
        waitingSince: b.waiting_since.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeQueueCursor(last.waiting_since, last.id) : null,
    };
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
        reviewSubmissions: {
          orderBy: { submittedAt: 'desc' },
          select: { submittedAt: true, decision: true, decidedAt: true, reason: true },
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
      submittedForReviewAt: shop.submittedForReviewAt?.toISOString() ?? null,
      ownerDocumentType: shop.ownerDocumentType,
      waitingSince: (shop.submittedForReviewAt ?? shop.flaggedAt ?? shop.createdAt).toISOString(),
      reviewNotes: shop.reviewNotes,
      submissions: shop.reviewSubmissions.map((r) => ({
        submittedAt: r.submittedAt.toISOString(),
        decision: r.decision,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        reason: r.reason,
      })),
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

  /**
   * Pedir cambios (rechazo con motivo): `PENDING_REVIEW` → `CHANGES_REQUESTED`. El dueño ve el
   * motivo, corrige y reenvía. Avisa a OWNER y MANAGER (`barbershop.review_changes_requested`).
   */
  async requestChanges(
    staff: StaffActor,
    barbershopId: string,
    reason: string,
  ): Promise<AdminBarbershopDetailDto> {
    await this.conflicts.assertNotMember(staff, barbershopId);
    await this.prisma.$transaction(async (tx) => {
      const [shop] = await tx.$queryRaw<{ status: BarbershopStatus }[]>`
        SELECT status FROM barbershops
         WHERE id = ${barbershopId}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (!shop) throw shopNotFound();
      if (shop.status !== 'PENDING_REVIEW') throw statusConflict(shop.status, 'CHANGES_REQUESTED');
      const now = new Date(this.clock.now());
      await tx.barbershop.update({
        where: { id: barbershopId },
        data: { status: 'CHANGES_REQUESTED', reviewNotes: reason, submittedForReviewAt: null },
      });
      await tx.barbershopReviewSubmission.updateMany({
        where: { barbershopId, decision: null },
        data: { decision: 'CHANGES_REQUESTED', decidedById: staff.id, decidedAt: now, reason },
      });
      await this.outbox.publish(tx, BARBERSHOP_REVIEW_CHANGES_REQUESTED_EVENT, { barbershopId });
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'barbershop.review_changes_requested',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: {
            values: { status: { from: 'PENDING_REVIEW', to: 'CHANGES_REQUESTED' } },
            reason,
            actorRole: staff.role,
          },
        },
        tx,
      );
    });
    return this.get(staff, barbershopId);
  }

  /** Documento completo del responsable: con motivo, auditado y sin caché. */
  async ownerDocument(
    staff: StaffActor,
    barbershopId: string,
    reason: string,
  ): Promise<{ type: string; number: string }> {
    await this.conflicts.assertNotMember(staff, barbershopId);
    const shop = await this.prisma.barbershop.findFirst({
      where: { id: barbershopId, deletedAt: null },
      select: { ownerDocumentType: true, ownerDocumentEnc: true },
    });
    if (!shop) throw shopNotFound();
    if (!shop.ownerDocumentType || !shop.ownerDocumentEnc) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'La barbería no tiene documento registrado.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.audit.record({
      actorId: staff.id,
      action: 'barbershop.owner_document_viewed',
      entityType: 'barbershop',
      entityId: barbershopId,
      changes: { reason, actorRole: staff.role },
    });
    return {
      type: shop.ownerDocumentType,
      number: this.encryption.decrypt(
        shop.ownerDocumentEnc,
        EncryptedField.BARBERSHOP_OWNER_DOCUMENT,
      ),
    };
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
      const approving = shop.status === 'PENDING_REVIEW' && to === 'OPEN';
      await tx.barbershop.update({
        where: { id: barbershopId },
        data: {
          status: to,
          ...(to === 'OPEN' ? { flaggedReason: null, flaggedAt: null } : {}),
          ...(approving ? { submittedForReviewAt: null, reviewNotes: null } : {}),
        },
      });
      if (approving) {
        await tx.barbershopReviewSubmission.updateMany({
          where: { barbershopId, decision: null },
          data: {
            decision: 'APPROVED',
            decidedById: staff.id,
            decidedAt: new Date(this.clock.now()),
          },
        });
        await this.outbox.publish(tx, BARBERSHOP_REVIEW_APPROVED_EVENT, { barbershopId });
      }
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
