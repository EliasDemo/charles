import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { PaymentStatus } from '../../generated/prisma/enums';
import { BookingStateMachine, SYSTEM_ACTOR } from '../bookings/booking-state-machine';
import {
  type ClientPaymentAction,
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type PaymentOutcome,
} from './payment-gateway';

export interface PaymentStartDto {
  paymentId: string;
  provider: string;
  status: PaymentStatus;
  amount: { amount: number; currency: string };
  /** null si la pasarela no respondió: reintentar con POST /bookings/{id}/payment. */
  clientAction: ClientPaymentAction | null;
}

const notAvailable = (message: string): AppException =>
  new AppException(ErrorCode.PAYMENT_NOT_AVAILABLE, message, HttpStatus.CONFLICT);

/**
 * Punto de unión entre reservas y pagos (Fase 7, con FakeGateway). Reglas:
 * - La fila `payments` (PENDING) se crea dentro de la transacción de la reserva.
 * - La llamada a la pasarela ocurre **después** del commit y se puede reintentar (misma clave).
 * - La reserva solo pasa a CONFIRMED por `handleResult` con un pago confirmado (RF-RES-003). En la
 *   Fase 8, el webhook verificado llamará a este mismo método.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: BookingStateMachine,
    private readonly outbox: OutboxService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Dentro de la transacción de la reserva: solo la fila, sin llamar a la pasarela. */
  async createPendingInTx(
    tx: Prisma.TransactionClient,
    booking: { id: string; totalAmount: number; currency: string },
  ): Promise<string> {
    const payment = await tx.payment.create({
      data: {
        bookingId: booking.id,
        provider: this.gateway.provider,
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
    const payment = await this.prisma.payment.findFirst({
      where: { bookingId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) throw notAvailable('La reserva no tiene un pago pendiente.');
    return this.callGateway(payment, booking.serviceNameSnapshot, true);
  }

  /** Igual que `start`, pero sin lanzar si la pasarela falla (lo usa la creación de la reserva). */
  async startAfterCreation(paymentId: string, description: string): Promise<PaymentStartDto> {
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    return this.callGateway(payment, description, false);
  }

  /**
   * Resultado verificado de un pago. Idempotente: un pago que ya no está PENDING no cambia.
   * - SUCCEEDED + reserva pendiente → CONFIRMED.
   * - SUCCEEDED + reserva vencida o cancelada → no se reactiva; `payment.orphaned` (reembolso en
   *   la Fase 8).
   * - REJECTED / CANCELLED + reserva pendiente → CANCELLED (CLAUDE.md §8).
   */
  async handleResult(paymentId: string, outcome: PaymentOutcome): Promise<PaymentStatus> {
    return this.prisma.$transaction(async (tx) => {
      const [payment] = await tx.$queryRaw<
        { status: PaymentStatus; booking_id: string; metadata: Prisma.JsonObject }[]
      >`SELECT status::text AS status, booking_id::text AS booking_id, metadata
          FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
      if (!payment) {
        throw new AppException(ErrorCode.NOT_FOUND, 'El pago no existe.', HttpStatus.NOT_FOUND);
      }
      if (payment.status !== 'PENDING') return payment.status;

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
          ...(orphaned ? { metadata: { ...payment.metadata, refundDecision: 'ORPHANED' } } : {}),
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
      }
      return outcome;
    });
  }

  /**
   * Al cancelar una reserva, dentro de su transacción. No se devuelve dinero: la política de
   * devolución está pendiente (CLAUDE.md §4.2). Un pago cobrado queda marcado y se publica el
   * evento para la Fase 8. Un pago aún PENDING se deja así: si luego se confirma, queda huérfano
   * y se reembolsa (nunca se pierde el rastro de un cobro).
   */
  async onBookingCancelled(
    tx: Prisma.TransactionClient,
    bookingId: string,
    cancelledByRole: string,
  ): Promise<void> {
    const paid = await tx.payment.findMany({
      where: { bookingId, status: 'SUCCEEDED' },
      select: { id: true, metadata: true },
    });
    for (const payment of paid) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...(payment.metadata as Prisma.JsonObject),
            refundDecision: 'PENDING_POLICY',
            cancelledByRole,
          },
        },
      });
      await this.outbox.publish(tx, 'payment.refund_decision_pending', {
        paymentId: payment.id,
        bookingId,
        cancelledByRole,
      });
    }
  }

  private async callGateway(
    payment: {
      id: string;
      provider: string;
      status: PaymentStatus;
      amount: number;
      currency: string;
      idempotencyKey: string;
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
      const result = await this.gateway.createPayment({
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
