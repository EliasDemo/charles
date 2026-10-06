import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { IdempotentConsumerStore } from '../../common/outbox/idempotent-consumer';
import { OutboxDispatcher } from '../../common/outbox/outbox.dispatcher';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ReviewReportTarget, ReviewStatus } from '../../generated/prisma/enums';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { HiddenReason, REVIEW_DEFAULTS, reachesReportThreshold } from './review-policy';
import { ReviewRatings } from './review-ratings';

export const ATTENDANCE_CORRECTED_EVENT = 'booking.attendance_corrected';
export const REVIEW_ATTENDANCE_CONSUMER = 'reviews.attendance-correction';

/** Decisión de soporte sobre una valoración o su respuesta (Fase 12 la expone). */
export type ModerationDecision = 'KEEP' | 'HIDE' | 'RESTORE';

interface LockedReview {
  id: string;
  booking_id: string;
  barbershop_id: string;
  barber_id: string;
  status: ReviewStatus;
  hidden_reason: string | null;
  response_status: ReviewStatus | null;
  deleted: boolean;
}

const reviewNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La valoración no existe.', HttpStatus.NOT_FOUND);

/**
 * Moderación de valoraciones y respuestas (RF-VAL-002). Único lugar que cambia su visibilidad:
 * - umbral de reportes → `UNDER_REVIEW` (sigue visible);
 * - decisión de soporte: mantener, ocultar o restaurar (endpoints en la Fase 12);
 * - corrección de asistencia (Fase 9): a `NO_SHOW` se oculta; de vuelta a `ATTENDED` se restaura,
 *   **solo** si la había ocultado esa corrección, nunca si la ocultó soporte.
 * Todo cambio de visibilidad de la valoración recalcula los promedios en la misma transacción.
 */
@Injectable()
export class ReviewModerationService implements OnModuleInit {
  private readonly logger = new Logger(ReviewModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ratings: ReviewRatings,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly store: IdempotentConsumerStore,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register({
      name: REVIEW_ATTENDANCE_CONSUMER,
      types: [ATTENDANCE_CORRECTED_EVENT],
      handle: async (message) => {
        const bookingId = message.payload.bookingId;
        if (typeof bookingId !== 'string') return;
        await this.store.runOnce(REVIEW_ATTENDANCE_CONSUMER, message.id, () =>
          this.syncWithAttendance(bookingId),
        );
      },
    });
  }

  async lock(tx: Prisma.TransactionClient, reviewId: string): Promise<LockedReview | null> {
    const [row] = await tx.$queryRaw<LockedReview[]>`
      SELECT id::text AS id, booking_id::text AS booking_id, barbershop_id::text AS barbershop_id,
             barber_id::text AS barber_id, status, hidden_reason, response_status,
             deleted_at IS NOT NULL AS deleted
        FROM reviews WHERE id = ${reviewId}::uuid FOR UPDATE`;
    return row ?? null;
  }

  async reportThreshold(): Promise<number> {
    return this.settings.positiveInt(
      SettingKey.REVIEWS_REPORT_THRESHOLD,
      REVIEW_DEFAULTS.reportThreshold,
    );
  }

  /**
   * Tras un reporte nuevo (en la transacción del reporte, con la valoración bloqueada): con el
   * umbral de reportes abiertos, lo visible pasa a `UNDER_REVIEW`. No cambia promedios.
   */
  async applyReportThreshold(
    tx: Prisma.TransactionClient,
    review: LockedReview,
    target: ReviewReportTarget,
  ): Promise<boolean> {
    const current = target === 'REVIEW' ? review.status : review.response_status;
    if (current !== 'VISIBLE') return false;
    const open = await tx.reviewReport.count({
      where: { reviewId: review.id, target, resolvedAt: null },
    });
    if (!reachesReportThreshold(open, await this.reportThreshold())) return false;
    await tx.review.update({
      where: { id: review.id },
      data: target === 'REVIEW' ? { status: 'UNDER_REVIEW' } : { responseStatus: 'UNDER_REVIEW' },
    });
    await this.audit.record(
      {
        action: 'review.under_review',
        entityType: 'review',
        entityId: review.id,
        changes: { target, openReports: open },
      },
      tx,
    );
    return true;
  }

  /**
   * Decisión de soporte (Fase 12). Resuelve los reportes abiertos del objetivo.
   * - KEEP: `UNDER_REVIEW` → `VISIBLE` (los reportes resueltos ya no cuentan para el umbral).
   * - HIDE: → `HIDDEN` (motivo `moderation`).
   * - RESTORE: `HIDDEN` por moderación → `VISIBLE`. Lo ocultado por la corrección de asistencia
   *   no se restaura a mano: depende de la asistencia.
   */
  async moderate(
    reviewId: string,
    target: ReviewReportTarget,
    decision: ModerationDecision,
    actorId: string,
    reason: string,
  ): Promise<{ status: ReviewStatus; resolvedReports: number }> {
    return this.prisma.$transaction(async (tx) => {
      const review = await this.lock(tx, reviewId);
      if (!review || review.deleted) throw reviewNotFound();
      const current = target === 'REVIEW' ? review.status : review.response_status;
      if (current === null) throw reviewNotFound();
      const next = this.decide(
        current,
        decision,
        target === 'REVIEW' ? review.hidden_reason : null,
      );

      if (target === 'REVIEW') {
        await tx.review.update({
          where: { id: reviewId },
          data: {
            status: next,
            hiddenReason: next === 'HIDDEN' ? HiddenReason.MODERATION : null,
          },
        });
        if ((current === 'HIDDEN') !== (next === 'HIDDEN')) {
          await this.ratings.recalculate(tx, review.barbershop_id, review.barber_id);
        }
      } else {
        await tx.review.update({ where: { id: reviewId }, data: { responseStatus: next } });
      }
      const { count } = await tx.reviewReport.updateMany({
        where: { reviewId, target, resolvedAt: null },
        data: { resolvedAt: new Date(), resolution: decision },
      });
      await this.audit.record(
        {
          actorId,
          action: 'review.moderated',
          entityType: 'review',
          entityId: reviewId,
          changes: { target, decision, from: current, to: next, reason, resolvedReports: count },
        },
        tx,
      );
      return { status: next, resolvedReports: count };
    });
  }

  private decide(
    current: ReviewStatus,
    decision: ModerationDecision,
    hiddenReason: string | null,
  ): ReviewStatus {
    switch (decision) {
      case 'HIDE':
        return 'HIDDEN';
      case 'KEEP':
        if (current === 'HIDDEN') break;
        return 'VISIBLE';
      case 'RESTORE':
        if (current !== 'HIDDEN' || hiddenReason === HiddenReason.ATTENDANCE_CORRECTED) break;
        return 'VISIBLE';
    }
    throw new AppException(
      ErrorCode.INVALID_STATE_TRANSITION,
      decision === 'RESTORE' && hiddenReason === HiddenReason.ATTENDANCE_CORRECTED
        ? 'Esta valoración está oculta por una corrección de asistencia; se restaura sola si la asistencia vuelve a ATTENDED.'
        : 'Esa decisión no aplica al estado actual.',
      HttpStatus.CONFLICT,
      [{ from: current, decision }],
    );
  }

  /**
   * Consumidor de `booking.attendance_corrected`. Lee el estado **actual** de la reserva (no el
   * del evento): así es idempotente y no depende del orden de entrega de varios eventos.
   */
  async syncWithAttendance(bookingId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.review.findUnique({ where: { bookingId }, select: { id: true } });
      if (!found) return;
      const review = await this.lock(tx, found.id);
      if (!review || review.deleted) return;
      const booking = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        select: { status: true },
      });

      if (booking.status === 'NO_SHOW' && review.status !== 'HIDDEN') {
        await tx.review.update({
          where: { id: review.id },
          data: { status: 'HIDDEN', hiddenReason: HiddenReason.ATTENDANCE_CORRECTED },
        });
        await this.ratings.recalculate(tx, review.barbershop_id, review.barber_id);
        await this.audit.record(
          {
            action: 'review.hidden',
            entityType: 'review',
            entityId: review.id,
            changes: { reason: HiddenReason.ATTENDANCE_CORRECTED, from: review.status },
          },
          tx,
        );
        return;
      }

      if (
        booking.status === 'ATTENDED' &&
        review.status === 'HIDDEN' &&
        review.hidden_reason === HiddenReason.ATTENDANCE_CORRECTED
      ) {
        // Si mientras estuvo oculta llegó al umbral de reportes, vuelve en revisión.
        const open = await tx.reviewReport.count({
          where: { reviewId: review.id, target: 'REVIEW', resolvedAt: null },
        });
        const status: ReviewStatus = reachesReportThreshold(open, await this.reportThreshold())
          ? 'UNDER_REVIEW'
          : 'VISIBLE';
        await tx.review.update({
          where: { id: review.id },
          data: { status, hiddenReason: null },
        });
        await this.ratings.recalculate(tx, review.barbershop_id, review.barber_id);
        await this.audit.record(
          {
            action: 'review.restored',
            entityType: 'review',
            entityId: review.id,
            changes: { reason: HiddenReason.ATTENDANCE_CORRECTED, to: status },
          },
          tx,
        );
        this.logger.log(
          { reviewId: review.id },
          'Valoración restaurada por corrección de asistencia',
        );
      }
    });
  }
}
