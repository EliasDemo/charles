import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';

export const SANCTION_DEFAULTS = { limit: 3, windowDays: 30 } as const;

export interface ReviewResult {
  status: 'JUSTIFIED' | 'UNJUSTIFIED';
  /** Injustificadas dentro de la ventana, contando esta. */
  unjustifiedInWindow: number;
  suspended: boolean;
}

/**
 * Sanción a la barbería por cancelar (Fase 8A; la pantalla de soporte es de la Fase 12):
 * - Cada cancelación hecha por la barbería (pagada o no) queda registrada para revisión, en la
 *   misma transacción que la cancelación.
 * - Soporte la califica como justificada o injustificada. Las pendientes no cuentan.
 * - Con `barbershops.unjustified_cancellations_limit` (3) injustificadas en
 *   `barbershops.unjustified_cancellations_window_days` (30) días, contados desde la fecha de cada
 *   cancelación, la barbería pasa a SUSPENDED en la misma transacción de la revisión.
 * - Las reservas futuras de una barbería suspendida se dejan como están (decisión de la Fase 12).
 * - La sanción económica está pendiente (docs/pendientes-produccion.md).
 */
@Injectable()
export class CancellationReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async recordInTx(
    tx: Prisma.TransactionClient,
    input: { bookingId: string; barbershopId: string; cancelledById: string; reason: string },
  ): Promise<string> {
    const review = await tx.barbershopCancellationReview.create({
      data: { ...input, cancelledAt: new Date(this.clock.now()) },
      select: { id: true },
    });
    await this.outbox.publish(tx, 'barbershop.cancellation_recorded', {
      reviewId: review.id,
      bookingId: input.bookingId,
      barbershopId: input.barbershopId,
    });
    return review.id;
  }

  /** Solo SUPPORT o ADMIN. Calificar dos veces la misma cancelación da 409. */
  async review(
    reviewerId: string,
    reviewId: string,
    verdict: 'JUSTIFIED' | 'UNJUSTIFIED',
    reason?: string,
  ): Promise<ReviewResult> {
    const reviewer = await this.users.findCredentialsById(reviewerId);
    if (!reviewer?.roles.some((role) => role === 'SUPPORT' || role === 'ADMIN')) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Solo soporte puede calificar cancelaciones.',
        HttpStatus.FORBIDDEN,
      );
    }
    const [limit, windowDays] = await Promise.all([
      this.settings.positiveInt(
        SettingKey.UNJUSTIFIED_CANCELLATIONS_LIMIT,
        SANCTION_DEFAULTS.limit,
      ),
      this.settings.positiveInt(
        SettingKey.UNJUSTIFIED_CANCELLATIONS_WINDOW_DAYS,
        SANCTION_DEFAULTS.windowDays,
      ),
    ]);
    const now = this.clock.now();

    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string; barbershop_id: string }[]>`
        SELECT status::text AS status, barbershop_id::text AS barbershop_id
          FROM barbershop_cancellation_reviews WHERE id = ${reviewId}::uuid FOR UPDATE`;
      if (!row) {
        throw new AppException(ErrorCode.NOT_FOUND, 'La revisión no existe.', HttpStatus.NOT_FOUND);
      }
      if (row.status !== 'PENDING_REVIEW') {
        throw new AppException(
          ErrorCode.ALREADY_REVIEWED,
          'Esta cancelación ya fue calificada.',
          HttpStatus.CONFLICT,
        );
      }
      // Serializa las revisiones de una misma barbería (el umbral no se cruza dos veces a la vez).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sanction:${row.barbershop_id}`}))`;
      await tx.barbershopCancellationReview.update({
        where: { id: reviewId },
        data: { status: verdict, reviewedById: reviewerId, reviewedAt: new Date(now) },
      });
      await this.audit.record(
        {
          actorId: reviewerId,
          action: 'barbershop.cancellation_reviewed',
          entityType: 'barbershop_cancellation_review',
          entityId: reviewId,
          changes: {
            values: { status: { from: 'PENDING_REVIEW', to: verdict } },
            ...(reason ? { reason } : {}),
          },
        },
        tx,
      );

      const unjustifiedInWindow = await tx.barbershopCancellationReview.count({
        where: {
          barbershopId: row.barbershop_id,
          status: 'UNJUSTIFIED',
          cancelledAt: { gte: new Date(now - windowDays * 24 * 3600_000) },
        },
      });
      let suspended = false;
      if (verdict === 'UNJUSTIFIED' && unjustifiedInWindow >= limit) {
        const previous = await this.access.suspendInTx(tx, row.barbershop_id);
        if (previous) {
          suspended = true;
          await this.audit.record(
            {
              actorId: reviewerId,
              action: 'barbershop.suspended',
              entityType: 'barbershop',
              entityId: row.barbershop_id,
              changes: {
                values: { status: { from: previous, to: 'SUSPENDED' } },
                reason: 'unjustified_cancellations',
                unjustifiedInWindow,
                windowDays,
              },
            },
            tx,
          );
          await this.outbox.publish(tx, 'barbershop.suspended', {
            barbershopId: row.barbershop_id,
            reason: 'unjustified_cancellations',
          });
        }
      }
      return { status: verdict, unjustifiedInWindow, suspended };
    });
  }
}
