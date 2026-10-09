import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { type Page, pageArgs, toPage } from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ReviewReportTarget } from '../../generated/prisma/enums';
import { BookingAttendanceService } from '../bookings/booking-attendance.service';
import { CancellationReviewsService } from '../moderation/cancellation-reviews.service';
import { PaymentsService } from '../payments/payments.service';
import {
  type ModerationDecision,
  ReviewModerationService,
} from '../reviews/review-moderation.service';
import { ConflictOfInterestService, type StaffActor } from './admin-access';
import type {
  AdminBookingDto,
  AdminCancellationReviewDto,
  AdminFailedRefundDto,
  AdminReviewDto,
  CancellationReviewQueryDto,
  ManualRefundDto,
  ModerationResultDto,
  ReportCountDto,
  SupportAttendanceCorrectionDto,
  VerdictResultDto,
} from './dto/admin.dto';
import type { PaginationQueryDto } from '../../common/pagination/pagination';

const notFound = (what: string): AppException =>
  new AppException(ErrorCode.NOT_FOUND, `${what} no existe.`, HttpStatus.NOT_FOUND);

/**
 * Reservas, pagos, cancelaciones de barberías y valoraciones (RF-OPE-003, Fase 12). Cada acción
 * comprueba el conflicto de interés: quien actúa no es el cliente ni miembro de la barbería.
 */
@Injectable()
export class AdminOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: BookingAttendanceService,
    private readonly payments: PaymentsService,
    private readonly cancellations: CancellationReviewsService,
    private readonly moderation: ReviewModerationService,
    private readonly conflicts: ConflictOfInterestService,
  ) {}

  // ───────────── Reservas y pagos ─────────────

  async booking(staff: StaffActor, bookingId: string): Promise<AdminBookingDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        barbershop: { select: { id: true, name: true, timezone: true } },
        barber: { select: { id: true, displayName: true } },
        client: { select: { id: true, fullName: true } },
        statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        payments: {
          orderBy: { createdAt: 'asc' },
          include: { refunds: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });
    if (!booking) throw notFound('La reserva');
    await this.conflicts.assertUninvolved(staff, {
      userId: booking.clientId,
      barbershopId: booking.barbershopId,
    });
    return {
      id: booking.id,
      status: booking.status,
      startAt: booking.startAt.toISOString(),
      endAt: booking.endAt.toISOString(),
      serviceName: booking.serviceNameSnapshot,
      totalAmount: booking.totalAmount,
      currency: booking.currency,
      barbershop: booking.barbershop,
      barber: booking.barber,
      client: booking.client,
      history: booking.statusHistory.map((h) => ({
        from: h.fromStatus,
        to: h.toStatus,
        reason: h.reason,
        at: h.createdAt.toISOString(),
      })),
      payments: booking.payments.map((p) => {
        const refunded = p.refunds
          .filter((r) => r.status !== 'FAILED')
          .reduce((sum, r) => sum + r.amount, 0);
        const charged = p.status === 'SUCCEEDED' || p.status === 'PARTIALLY_REFUNDED';
        return {
          id: p.id,
          status: p.status,
          amount: p.amount,
          currency: p.currency,
          provider: p.provider,
          refundable: charged ? Math.max(p.amount - refunded, 0) : 0,
          refunds: p.refunds.map((r) => ({
            id: r.id,
            amount: r.amount,
            status: r.status,
            reasonType: r.reasonType,
            createdAt: r.createdAt.toISOString(),
          })),
        };
      }),
    };
  }

  /** Corrección de asistencia fuera del plazo del responsable. */
  async correctAttendance(
    staff: StaffActor,
    bookingId: string,
    dto: SupportAttendanceCorrectionDto,
  ): Promise<AdminBookingDto> {
    await this.booking(staff, bookingId); // existencia y conflicto de interés
    await this.attendance.correctBySupport(staff.id, staff.role, bookingId, dto);
    return this.booking(staff, bookingId);
  }

  /** Solo ADMIN: reembolso manual con motivo, hasta lo cobrado. */
  async manualRefund(
    staff: StaffActor,
    paymentId: string,
    dto: ManualRefundDto,
  ): Promise<{ refundId: string }> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { booking: { select: { clientId: true, barbershopId: true } } },
    });
    if (!payment) throw notFound('El pago');
    await this.conflicts.assertUninvolved(staff, {
      userId: payment.booking.clientId,
      barbershopId: payment.booking.barbershopId,
    });
    const refundId = await this.payments.requestManualRefund({
      actorId: staff.id,
      paymentId,
      amount: dto.amount,
      reason: dto.reason,
    });
    return { refundId };
  }

  /** Fase 10: reembolsos fallidos en la pasarela, para que soporte los resuelva. */
  async failedRefunds(query: PaginationQueryDto): Promise<Page<AdminFailedRefundDto>> {
    const args = pageArgs(query);
    const rows = await this.prisma.refund.findMany({
      where: { ...args.where, status: 'FAILED' },
      orderBy: args.orderBy,
      take: args.take,
      include: { payment: { select: { id: true, currency: true, bookingId: true } } },
    });
    return toPage(rows, query, (r) => ({
      id: r.id,
      amount: r.amount,
      currency: r.payment.currency,
      reasonType: r.reasonType,
      paymentId: r.payment.id,
      bookingId: r.payment.bookingId,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ───────────── Cancelaciones de barberías (8A) ─────────────

  async cancellationReviews(
    query: CancellationReviewQueryDto,
  ): Promise<Page<AdminCancellationReviewDto>> {
    const args = pageArgs(query);
    const rows = await this.prisma.barbershopCancellationReview.findMany({
      where: { ...args.where, status: query.status ?? 'PENDING_REVIEW' },
      orderBy: args.orderBy,
      take: args.take,
      include: { barbershop: { select: { id: true, name: true } } },
    });
    return toPage(rows, query, (r) => ({
      id: r.id,
      bookingId: r.bookingId,
      barbershop: r.barbershop,
      reason: r.reason,
      cancelledAt: r.cancelledAt.toISOString(),
      status: r.status,
    }));
  }

  async cancellationVerdict(
    staff: StaffActor,
    reviewId: string,
    verdict: 'JUSTIFIED' | 'UNJUSTIFIED',
    reason: string,
  ): Promise<VerdictResultDto> {
    const review = await this.prisma.barbershopCancellationReview.findUnique({
      where: { id: reviewId },
      select: { barbershopId: true },
    });
    if (!review) throw notFound('La revisión');
    await this.conflicts.assertNotMember(staff, review.barbershopId);
    const result = await this.cancellations.review(staff.id, reviewId, verdict, reason);
    return { verdict, barbershopSuspended: result.suspended };
  }

  // ───────────── Valoraciones (Fase 11) ─────────────

  /** Valoraciones o respuestas en revisión (`UNDER_REVIEW`), las más antiguas primero. */
  async reportedReviews(query: PaginationQueryDto): Promise<Page<AdminReviewDto>> {
    const args = pageArgs(query);
    const rows = await this.prisma.review.findMany({
      where: {
        ...args.where,
        deletedAt: null,
        OR: [{ status: 'UNDER_REVIEW' }, { responseStatus: 'UNDER_REVIEW' }],
      },
      orderBy: args.orderBy,
      take: args.take,
      include: {
        barbershop: { select: { id: true, name: true } },
        reports: {
          where: { resolvedAt: null },
          select: { target: true, reason: true },
        },
      },
    });
    const count = (reports: { target: ReviewReportTarget; reason: string }[], target: string) => {
      const map = new Map<string, number>();
      for (const r of reports.filter((x) => x.target === target)) {
        map.set(r.reason, (map.get(r.reason) ?? 0) + 1);
      }
      return [...map].map(([reason, n]): ReportCountDto => ({ reason, count: n }));
    };
    return toPage(rows, query, (r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      status: r.status,
      responseText: r.responseText,
      responseStatus: r.responseStatus,
      barbershop: r.barbershop,
      reviewReports: count(r.reports, 'REVIEW'),
      responseReports: count(r.reports, 'RESPONSE'),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async moderateReview(
    staff: StaffActor,
    reviewId: string,
    target: ReviewReportTarget,
    decision: ModerationDecision,
    reason: string,
  ): Promise<ModerationResultDto> {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { clientId: true, barbershopId: true },
    });
    if (!review) throw notFound('La valoración');
    await this.conflicts.assertUninvolved(staff, {
      userId: review.clientId,
      barbershopId: review.barbershopId,
    });
    return this.moderation.moderate(reviewId, target, decision, staff.id, reason);
  }
}
