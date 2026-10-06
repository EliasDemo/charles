import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import {
  InvalidSignatureError,
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type PaymentWebhookEvent,
  type RawWebhook,
} from './payment-gateway';
import { PaymentsService } from './payments.service';
import { WebhookRateLimiter } from './webhook-rate-limit';

export interface WebhookReceipt {
  received: true;
  duplicate: boolean;
}

const reject = (code: string, message: string, status: HttpStatus): AppException =>
  new AppException(code, message, status);

/**
 * Webhooks de la pasarela (IPN en Izipay). Orden:
 * 1. Proveedor conocido (404 si no).
 * 2. Firma sobre el cuerpo exacto (401 si es inválida). Nada se procesa sin firma válida.
 * 3. Antigüedad, solo si el proveedor envía marca de tiempo (`webhookMaxAgeSeconds`; Izipay no).
 * 4. Coherencia: pago existente, importe, moneda y modo (en producción nunca TEST).
 * 5. En una transacción: registro en `payment_events` (único por proveedor y evento) y aplicación.
 *    Un evento repetido responde 200 sin volver a aplicarse.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly rateLimiter: WebhookRateLimiter,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async receive(provider: string, raw: RawWebhook, ip: string): Promise<WebhookReceipt> {
    if (provider.toUpperCase() !== this.gateway.provider) {
      throw reject(ErrorCode.NOT_FOUND, 'Proveedor desconocido.', HttpStatus.NOT_FOUND);
    }
    await this.rateLimiter.assertIpNotBlocked(ip);
    let event: PaymentWebhookEvent;
    try {
      event = this.gateway.parseWebhook(raw);
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        await this.rateLimiter.recordInvalid(ip);
        this.logger.warn(`Webhook de ${provider} con firma inválida`);
        throw reject(ErrorCode.INVALID_SIGNATURE, 'Firma inválida.', HttpStatus.UNAUTHORIZED);
      }
      throw error;
    }
    await this.rateLimiter.consumeProvider(this.gateway.provider);
    this.assertFresh(event);
    await this.assertCoherent(event);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.paymentEvent.create({
          data: {
            provider: this.gateway.provider,
            providerEventId: event.providerEventId,
            paymentId: event.paymentId,
            type: `${event.kind.toLowerCase()}.${event.outcome.toLowerCase()}`,
            payload: { ...event.payload, refundId: event.refundId },
            processedAt: new Date(this.clock.now()),
          },
        });
        if (event.kind === 'PAYMENT') {
          if (event.outcome === 'FAILED') return;
          await this.payments.applyPaymentResult(tx, event.paymentId, event.outcome, 'WEBHOOK');
        } else if (
          event.refundId &&
          (event.outcome === 'SUCCEEDED' || event.outcome === 'FAILED')
        ) {
          await this.payments.applyRefundResult(tx, event.refundId, event.outcome);
        }
      });
    } catch (error) {
      // Mismo evento ya registrado (reintento del proveedor o entrega duplicada): sin efectos.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { received: true, duplicate: true };
      }
      throw error;
    }
    return { received: true, duplicate: false };
  }

  /** Solo si el proveedor envía marca de tiempo; si no, la protección es la idempotencia. */
  private assertFresh(event: PaymentWebhookEvent): void {
    const maxAge = this.gateway.webhookMaxAgeSeconds;
    if (maxAge === null) return;
    const age = event.occurredAt ? Math.abs(this.clock.now() - event.occurredAt.getTime()) : null;
    if (age === null || age > maxAge * 1000) {
      throw reject(ErrorCode.WEBHOOK_TOO_OLD, 'Aviso fuera de plazo.', HttpStatus.BAD_REQUEST);
    }
  }

  private async assertCoherent(event: PaymentWebhookEvent): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: event.paymentId },
      select: { amount: true, currency: true, provider: true },
    });
    const problems: string[] = [];
    if (!payment || payment.provider !== this.gateway.provider) problems.push('unknownPayment');
    if (payment && event.currency !== payment.currency) problems.push('currency');
    if (payment && event.kind === 'PAYMENT' && event.amount !== payment.amount)
      problems.push('amount');
    if (this.config.isProduction && event.mode === 'TEST') problems.push('mode');
    if (event.kind === 'REFUND') {
      const refund = event.refundId
        ? await this.prisma.refund.findUnique({
            where: { id: event.refundId },
            select: { paymentId: true, amount: true },
          })
        : null;
      if (!refund || refund.paymentId !== event.paymentId) problems.push('unknownRefund');
      else if (refund.amount !== event.amount) problems.push('amount');
    }
    if (problems.length === 0) return;
    await this.audit.record({
      action: 'payment.webhook_rejected',
      entityType: 'payment',
      entityId: payment ? event.paymentId : null,
      changes: { providerEventId: event.providerEventId, problems },
    });
    throw reject(
      ErrorCode.WEBHOOK_MISMATCH,
      'El aviso no coincide con el pago registrado.',
      HttpStatus.CONFLICT,
    );
  }
}
