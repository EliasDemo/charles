import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Payment, Prisma } from '../../generated/prisma/client';
import type { PaymentStatus, RefundReason, RefundStatus } from '../../generated/prisma/enums';
import { BookingStateMachine, SYSTEM_ACTOR } from '../bookings/booking-state-machine';
import { SettingKey, SettingsService } from '../settings/settings.service';
import type { PaymentViewDto } from './dto/payment.dto';
import {
  type ClientPaymentAction,
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type PaymentOutcome,
} from './payment-gateway';
import {
  type CancelledBy,
  normalizeRefundSettings,
  type RefundPolicySettings,
  type RefundQuote,
  refundQuote,
} from './refund-policy';
import { restoreCredit } from '../memberships/membership-credits';
import { SellerAccountsService } from './marketplace/seller-accounts';
import type { SellerCredentials } from './payment-gateway';

export interface PaymentStartDto {
  paymentId: string;
  provider: string;
  status: PaymentStatus;
  amount: { amount: number; currency: string };
  /** null si la pasarela no respondió: reintentar con POST /bookings/{id}/payment. */
  clientAction: ClientPaymentAction | null;
}

/** Quién origina la aplicación de un resultado (queda en el historial y la auditoría). */
export type ResultSource = 'WEBHOOK' | 'RECONCILIATION';

export const REFUND_REQUESTED_EVENT = 'refund.requested';
/** Fase 16: medio de pago de una reserva pagada con un crédito de membresía. */
export const MEMBERSHIP_CREDIT_METHOD = 'MEMBERSHIP_CREDIT';

const REFUND_REASON_BY: Record<CancelledBy, RefundReason> = {
  CLIENT: 'CLIENT_CANCELLATION',
  BARBERSHOP: 'BARBERSHOP_CANCELLATION',
  SUPPORT: 'SUPPORT_CANCELLATION',
};

/** Estado final y si esta llamada cambió algo (false = ya estaba resuelto: idempotente). */
export interface ApplyResult<S> {
  status: S;
  applied: boolean;
}

const notAvailable = (message: string): AppException =>
  new AppException(ErrorCode.PAYMENT_NOT_AVAILABLE, message, HttpStatus.CONFLICT);

/**
 * Pagos y reembolsos, independientes del proveedor (Fase 8A). Reglas:
 * - Las filas (`payments`, `refunds`) se crean dentro de las transacciones de negocio; las llamadas
 *   a la pasarela ocurren después del commit y se pueden reintentar con la misma clave.
 * - La reserva pasa a CONFIRMED **solo** por `applyPaymentResult`, que llaman el webhook verificado
 *   y la conciliación (nunca la app).
 * - Un pago o reembolso que ya no está PENDING no cambia: aplicar dos veces el mismo resultado no
 *   tiene efecto.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: BookingStateMachine,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly sellers: SellerAccountsService,
  ) {}

  // ───────────── Cobro ─────────────

  /** Dentro de la transacción de la reserva: solo la fila, sin llamar a la pasarela. */
  async createPendingInTx(
    tx: Prisma.TransactionClient,
    booking: {
      id: string;
      barbershopId: string;
      totalAmount: number;
      commissionAmount: number;
      currency: string;
    },
  ): Promise<string> {
    // Marketplace: con la cuenta de la barbería vinculada, el cobro va directo a ella.
    const seller = await this.sellers.isConnectedInTx(tx, booking.barbershopId);
    const payment = await tx.payment.create({
      data: {
        bookingId: booking.id,
        provider: this.gateway.provider,
        payee: seller ? 'SELLER' : 'PLATFORM',
        marketplaceFee: seller ? Math.min(booking.commissionAmount, booking.totalAmount) : null,
        status: 'PENDING',
        amount: booking.totalAmount,
        currency: booking.currency,
        idempotencyKey: `booking:${booking.id}`,
      },
      select: { id: true },
    });
    return payment.id;
  }

  /**
   * Inicia (o reintenta) el cobro en la pasarela, fuera de toda transacción. Idempotente: la
   * pasarela recibe siempre la misma clave. Solo el cliente de la reserva, mientras esté
   * pendiente de pago y vigente.
   */
  async start(clientId: string, bookingId: string): Promise<PaymentStartDto> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, clientId },
      select: { status: true, expiresAt: true, serviceNameSnapshot: true },
    });
    if (!booking) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La reserva no existe.', HttpStatus.NOT_FOUND);
    }
    if (booking.status !== 'PENDING_PAYMENT') {
      throw notAvailable('La reserva ya no está pendiente de pago.');
    }
    if (!booking.expiresAt || booking.expiresAt.getTime() <= this.clock.now()) {
      throw notAvailable('El plazo para pagar venció. Vuelve a reservar.');
    }
    const payment = await this.pendingPaymentOf(bookingId);
    if (!payment) throw notAvailable('La reserva no tiene un pago pendiente.');
    return this.callGateway(payment, booking.serviceNameSnapshot, true);
  }

  /** Igual que `start`, pero sin lanzar si la pasarela falla (lo usa la creación de la reserva). */
  async startAfterCreation(paymentId: string, description: string): Promise<PaymentStartDto> {
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    return this.callGateway(payment, description, false);
  }

  /** Pago PENDING de una reserva (el más reciente). */
  pendingPaymentOf(bookingId: string): Promise<Payment | null> {
    return this.prisma.payment.findFirst({
      where: { bookingId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Resultado verificado de un pago, en su propia transacción. Ver `applyPaymentResult`. */
  handleResult(
    paymentId: string,
    outcome: PaymentOutcome,
    source: ResultSource,
  ): Promise<ApplyResult<PaymentStatus>> {
    return this.prisma.$transaction((tx) =>
      this.applyPaymentResult(tx, paymentId, outcome, source),
    );
  }

  /**
   * Único camino para aplicar el resultado de un pago. Idempotente: un pago que ya no está
   * PENDING no cambia.
   * - SUCCEEDED + reserva pendiente → CONFIRMED.
   * - SUCCEEDED + reserva vencida o cancelada → no se reactiva: pago huérfano, devolución total
   *   automática (decisión de la Fase 8A).
   * - REJECTED / CANCELLED + reserva pendiente → CANCELLED (CLAUDE.md §8).
   */
  async applyPaymentResult(
    tx: Prisma.TransactionClient,
    paymentId: string,
    outcome: PaymentOutcome,
    source: ResultSource,
    providerData?: Record<string, string>,
  ): Promise<ApplyResult<PaymentStatus>> {
    const [payment] = await tx.$queryRaw<
      { status: PaymentStatus; booking_id: string; amount: number; metadata: Prisma.JsonObject }[]
    >`SELECT status::text AS status, booking_id::text AS booking_id, amount, metadata
        FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    if (!payment) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El pago no existe.', HttpStatus.NOT_FOUND);
    }
    if (payment.status !== 'PENDING') return { status: payment.status, applied: false };

    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: payment.booking_id },
      select: { status: true },
    });
    const orphaned = outcome === 'SUCCEEDED' && booking.status !== 'PENDING_PAYMENT';
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: outcome,
        confirmedAt: outcome === 'SUCCEEDED' ? new Date(this.clock.now()) : null,
        metadata: {
          ...payment.metadata,
          resultSource: source,
          ...(orphaned ? { refundDecision: 'ORPHANED' } : {}),
          // Lo que el proveedor necesita para devolver (Izipay: uniqueId, autorización…).
          ...(providerData ? { provider: providerData } : {}),
        },
      },
    });

    if (booking.status === 'PENDING_PAYMENT') {
      if (outcome === 'SUCCEEDED') {
        await this.stateMachine.transition(tx, payment.booking_id, 'CONFIRMED', SYSTEM_ACTOR);
      } else {
        await this.stateMachine.transition(
          tx,
          payment.booking_id,
          'CANCELLED',
          SYSTEM_ACTOR,
          outcome === 'REJECTED' ? 'payment_rejected' : 'payment_cancelled',
        );
      }
    } else if (orphaned) {
      await this.outbox.publish(tx, 'payment.orphaned', {
        paymentId,
        bookingId: payment.booking_id,
        bookingStatus: booking.status,
      });
      await this.requestRefundInTx(tx, {
        paymentId,
        amount: payment.amount,
        reasonType: 'ORPHANED_PAYMENT',
        reason: `booking_${booking.status.toLowerCase()}`,
        idempotencyKey: `refund:orphaned:${paymentId}`,
      });
    }
    return { status: outcome, applied: true };
  }

  // ───────────── Reembolsos ─────────────

  async loadRefundSettings(): Promise<RefundPolicySettings> {
    const [full, partial, percent] = await Promise.all([
      this.settings.get(SettingKey.REFUND_FULL_MIN_MINUTES),
      this.settings.get(SettingKey.REFUND_PARTIAL_MIN_MINUTES),
      this.settings.get(SettingKey.REFUND_PARTIAL_PERCENT),
    ]);
    return normalizeRefundSettings({
      fullRefundMinMinutes: full as number,
      partialRefundMinMinutes: partial as number,
      partialRefundPercent: percent as number,
    });
  }

  /** Cobrado y aún no devuelto (ni pedido para devolver) de una reserva. */
  async refundableOf(
    bookingId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<{ paymentId: string; refundable: number } | null> {
    const paid = await tx.payment.findFirst({
      where: { bookingId, status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] } },
      include: { refunds: { where: { status: { not: 'FAILED' } }, select: { amount: true } } },
    });
    if (!paid) return null;
    const refunded = paid.refunds.reduce((sum, r) => sum + r.amount, 0);
    return { paymentId: paid.id, refundable: Math.max(paid.amount - refunded, 0) };
  }

  /** Cuánto se devolvería si se cancela ahora (vista previa y cancelación usan lo mismo). */
  async quoteCancellation(
    booking: { id: string; startAt: Date },
    by: CancelledBy,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<RefundQuote & { paymentId: string | null }> {
    const [refundable, settings] = await Promise.all([
      this.refundableOf(booking.id, tx),
      this.loadRefundSettings(),
    ]);
    const quote = refundQuote({
      refundableAmount: refundable?.refundable ?? 0,
      by,
      startAt: booking.startAt.getTime(),
      now: this.clock.now(),
      settings,
    });
    return { ...quote, paymentId: refundable?.paymentId ?? null };
  }

  /**
   * Al cancelar una reserva, dentro de su transacción: aplica la política de devolución.
   * Un pago aún PENDING se deja así: si luego se confirma, es huérfano y se devuelve completo.
   */
  async onBookingCancelled(
    tx: Prisma.TransactionClient,
    booking: { id: string; startAt: Date },
    by: CancelledBy,
  ): Promise<RefundQuote> {
    const quote = await this.quoteCancellation(booking, by, tx);
    if (quote.paymentId && quote.amount > 0) {
      await this.requestRefundInTx(tx, {
        paymentId: quote.paymentId,
        amount: quote.amount,
        reasonType: REFUND_REASON_BY[by],
        reason: quote.rule.toLowerCase(),
        idempotencyKey: `refund:cancellation:${booking.id}`,
      });
    }
    return quote;
  }

  /**
   * Crea el reembolso PENDING y publica `refund.requested`; la llamada a la pasarela la hace
   * después el consumidor del outbox (`executeRefund`). La base impide devolver más de lo pagado.
   */
  async requestRefundInTx(
    tx: Prisma.TransactionClient,
    input: {
      paymentId: string;
      amount: number;
      reasonType: RefundReason;
      reason: string | null;
      idempotencyKey: string;
    },
  ): Promise<string> {
    const refund = await tx.refund.create({
      data: {
        paymentId: input.paymentId,
        amount: input.amount,
        reasonType: input.reasonType,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      },
      select: { id: true },
    });
    // Fase 16: pagada con crédito de membresía. No hay dinero que devolver: vuelve el crédito.
    const paidWith = await tx.payment.findUnique({
      where: { id: input.paymentId },
      select: { method: true, bookingId: true },
    });
    if (paidWith?.method === MEMBERSHIP_CREDIT_METHOD) {
      await restoreCredit(tx, { bookingId: paidWith.bookingId }, this.clock.now());
      await this.applyRefundResult(tx, refund.id, 'SUCCEEDED');
      return refund.id;
    }
    await this.outbox.publish(tx, REFUND_REQUESTED_EVENT, {
      refundId: refund.id,
      paymentId: input.paymentId,
      amount: input.amount,
      reasonType: input.reasonType,
    });
    return refund.id;
  }

  /**
   * Reembolso manual (solo ADMIN, Fase 12), con motivo, hasta lo cobrado y aún no devuelto, y
   * auditado. Bloquea el pago: dos reembolsos manuales simultáneos no superan el límite.
   */
  async requestManualRefund(input: {
    actorId: string;
    paymentId: string;
    amount: number;
    reason: string;
  }): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const [payment] = await tx.$queryRaw<{ booking_id: string; status: string }[]>`
        SELECT booking_id::text AS booking_id, status::text AS status
          FROM payments WHERE id = ${input.paymentId}::uuid FOR UPDATE`;
      if (!payment) {
        throw new AppException(ErrorCode.NOT_FOUND, 'El pago no existe.', HttpStatus.NOT_FOUND);
      }
      const refundable = await this.refundableOf(payment.booking_id, tx);
      if (!refundable || refundable.paymentId !== input.paymentId) {
        throw new AppException(
          ErrorCode.REFUND_EXCEEDS_PAID,
          'Este pago no tiene un cobro confirmado que se pueda devolver.',
          HttpStatus.CONFLICT,
          [{ refundable: 0 }],
        );
      }
      if (input.amount > refundable.refundable) {
        throw new AppException(
          ErrorCode.REFUND_EXCEEDS_PAID,
          'El importe supera lo cobrado y aún no devuelto.',
          HttpStatus.CONFLICT,
          [{ refundable: refundable.refundable }],
        );
      }
      const refundId = await this.requestRefundInTx(tx, {
        paymentId: input.paymentId,
        amount: input.amount,
        reasonType: 'MANUAL',
        reason: input.reason,
        // Cada reembolso manual es una solicitud distinta (dos en el mismo milisegundo no chocan).
        idempotencyKey: `refund:manual:${input.paymentId}:${randomUUID()}`,
      });
      await this.audit.record(
        {
          actorId: input.actorId,
          action: 'refund.manual_requested',
          entityType: 'payment',
          entityId: input.paymentId,
          changes: { refundId, amount: input.amount, reason: input.reason, actorRole: 'ADMIN' },
        },
        tx,
      );
      return refundId;
    });
  }

  /**
   * Envía a la pasarela un reembolso PENDING aún no enviado. Fuera de toda transacción y con
   * la misma clave de idempotencia (reintentable). Si la pasarela falla, lanza: el outbox reintenta.
   */
  async executeRefund(refundId: string): Promise<void> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { payment: true },
    });
    if (!refund || refund.status !== 'PENDING' || refund.requestedAt) return;
    const seller = await this.sellerOf(refund.payment);
    const result = await this.gateway.refund({
      ...(seller ? { seller } : {}),
      refundId,
      paymentId: refund.paymentId,
      providerPaymentId: refund.payment.providerPaymentId,
      providerData: providerDataOf(refund.payment.metadata),
      amount: refund.amount,
      currency: refund.payment.currency,
      idempotencyKey: refund.idempotencyKey,
    });
    await this.prisma.refund.updateMany({
      where: { id: refundId, requestedAt: null },
      data: { requestedAt: new Date(this.clock.now()), providerRefundId: result.providerRefundId },
    });
    if (result.status === 'SUCCEEDED') await this.handleRefundResult(refundId, 'SUCCEEDED');
  }

  handleRefundResult(
    refundId: string,
    outcome: 'SUCCEEDED' | 'FAILED',
  ): Promise<ApplyResult<RefundStatus>> {
    return this.prisma.$transaction((tx) => this.applyRefundResult(tx, refundId, outcome));
  }

  /** Único camino para aplicar el resultado de un reembolso. Idempotente. */
  async applyRefundResult(
    tx: Prisma.TransactionClient,
    refundId: string,
    outcome: 'SUCCEEDED' | 'FAILED',
  ): Promise<ApplyResult<RefundStatus>> {
    const [refund] = await tx.$queryRaw<
      { status: RefundStatus; payment_id: string; amount: number }[]
    >`SELECT status::text AS status, payment_id::text AS payment_id, amount
        FROM refunds WHERE id = ${refundId}::uuid FOR UPDATE`;
    if (!refund) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El reembolso no existe.', HttpStatus.NOT_FOUND);
    }
    if (refund.status !== 'PENDING') return { status: refund.status, applied: false };
    await tx.refund.update({
      where: { id: refundId },
      data: { status: outcome, processedAt: new Date(this.clock.now()) },
    });
    if (outcome === 'SUCCEEDED') {
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: refund.payment_id },
        include: { refunds: { where: { status: 'SUCCEEDED' }, select: { amount: true } } },
      });
      const refunded = payment.refunds.reduce((sum, r) => sum + r.amount, 0);
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: refunded >= payment.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      });
    }
    await this.outbox.publish(tx, outcome === 'SUCCEEDED' ? 'refund.succeeded' : 'refund.failed', {
      refundId,
      paymentId: refund.payment_id,
      amount: refund.amount,
    });
    return { status: outcome, applied: true };
  }

  // ───────────── Consulta ─────────────

  /** Estado del pago y sus reembolsos (cliente de la reserva). */
  async statusOf(clientId: string, bookingId: string): Promise<PaymentViewDto[]> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, clientId },
      select: { id: true },
    });
    if (!booking) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La reserva no existe.', HttpStatus.NOT_FOUND);
    }
    const payments = await this.prisma.payment.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'asc' },
      include: { refunds: { orderBy: { createdAt: 'asc' } } },
    });
    return payments.map((p) => ({
      paymentId: p.id,
      provider: p.provider,
      status: p.status,
      amount: { amount: p.amount, currency: p.currency },
      startedAt: p.startedAt,
      confirmedAt: p.confirmedAt,
      refunds: p.refunds.map((r) => ({
        refundId: r.id,
        status: r.status,
        reasonType: r.reasonType,
        amount: { amount: r.amount, currency: p.currency },
        createdAt: r.createdAt,
        processedAt: r.processedAt,
      })),
    }));
  }

  /**
   * Marketplace: credenciales de la barbería si el pago se cobra (o se cobró) con su cuenta.
   * Lanza si la cuenta ya no está disponible: el pago es de ella y no se puede operar con otra.
   */
  async sellerOf(payment: {
    id: string;
    payee: 'PLATFORM' | 'SELLER';
    bookingId: string;
  }): Promise<SellerCredentials | null> {
    if (payment.payee !== 'SELLER') return null;
    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id: payment.bookingId },
      select: { barbershopId: true },
    });
    const credentials = await this.sellers.credentialsFor(booking.barbershopId);
    if (!credentials) {
      throw new AppException(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'La cuenta de Mercado Pago de la barbería no está disponible.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return credentials;
  }

  private async callGateway(
    payment: {
      id: string;
      provider: string;
      status: PaymentStatus;
      amount: number;
      currency: string;
      idempotencyKey: string;
      payee: 'PLATFORM' | 'SELLER';
      marketplaceFee: number | null;
      bookingId: string;
      startedAt: Date | null;
    },
    description: string,
    throwOnFailure: boolean,
  ): Promise<PaymentStartDto> {
    const base = {
      paymentId: payment.id,
      provider: payment.provider,
      status: payment.status,
      amount: { amount: payment.amount, currency: payment.currency },
    };
    try {
      let seller: SellerCredentials | null = null;
      if (payment.payee === 'SELLER') {
        const booking = await this.prisma.booking.findUniqueOrThrow({
          where: { id: payment.bookingId },
          select: { barbershopId: true },
        });
        seller = await this.sellers.credentialsFor(booking.barbershopId);
        // La barbería se desvinculó antes de iniciar el cobro: se cobra con la cuenta de Charles.
        if (!seller && payment.startedAt) throw new Error('Cuenta de la barbería no disponible');
        if (!seller && !payment.startedAt) {
          await this.prisma.payment.updateMany({
            where: { id: payment.id, startedAt: null },
            data: { payee: 'PLATFORM', marketplaceFee: null },
          });
        }
      }
      const result = await this.gateway.createPayment({
        ...(seller ? { seller: { ...seller, marketplaceFee: payment.marketplaceFee ?? 0 } } : {}),
        paymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        idempotencyKey: payment.idempotencyKey,
        description,
      });
      await this.prisma.payment.updateMany({
        where: { id: payment.id, providerPaymentId: null },
        data: { providerPaymentId: result.providerPaymentId },
      });
      // Pago iniciado: desde ahora la conciliación lo consulta a la pasarela.
      await this.prisma.payment.updateMany({
        where: { id: payment.id, startedAt: null },
        data: { startedAt: new Date(this.clock.now()) },
      });
      return { ...base, clientAction: result.clientAction };
    } catch (error) {
      this.logger.warn(
        `La pasarela no respondió para el pago ${payment.id}: ${error instanceof Error ? error.name : 'error'}`,
      );
      if (throwOnFailure) {
        throw new AppException(
          ErrorCode.PAYMENT_PROVIDER_ERROR,
          'No pudimos iniciar el pago. Inténtalo nuevamente en unos segundos.',
          HttpStatus.BAD_GATEWAY,
        );
      }
      return { ...base, clientAction: null };
    }
  }
}

/** `metadata.provider` de un pago (datos del proveedor guardados al confirmarlo). */
export function providerDataOf(metadata: Prisma.JsonValue): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const provider = metadata.provider;
  return provider && typeof provider === 'object' && !Array.isArray(provider) ? provider : null;
}
