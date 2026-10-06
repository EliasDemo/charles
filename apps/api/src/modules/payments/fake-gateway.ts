import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, systemClock } from '../../common/clock/clock';
import {
  type CreatePaymentInput,
  type CreatePaymentResult,
  InvalidSignatureError,
  type PaymentGateway,
  PaymentGatewayError,
  type PaymentWebhookEvent,
  type ProviderPaymentState,
  type ProviderRefundState,
  type RawWebhook,
  type RefundInput,
  type RefundResult,
} from './payment-gateway';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/** Cuerpo de un webhook de la pasarela simulada. */
export interface FakeWebhookBody {
  eventId: string;
  kind: 'PAYMENT' | 'REFUND';
  paymentId: string;
  refundId?: string | null;
  outcome: PaymentWebhookEvent['outcome'];
  amount: number;
  currency: string;
  mode: 'TEST' | 'PRODUCTION';
  transactionId?: string | null;
  occurredAt?: string | null;
}

interface FakePayment {
  amount: number;
  currency: string;
  status: ProviderPaymentState['status'];
  transactionId: string | null;
}

/**
 * Pasarela simulada (desarrollo y pruebas). Nunca se permite en producción.
 * - Guarda en memoria el estado "del lado del proveedor": las pruebas pueden simular que el
 *   cliente pagó sin que llegue el webhook (webhook perdido) o que la pasarela está caída.
 * - Firma los webhooks con HMAC-SHA-256 sobre el cuerpo exacto, con un secreto aleatorio por
 *   proceso (nunca escrito en el repositorio).
 * - Idempotente: la misma clave da siempre el mismo identificador.
 */
@Injectable()
export class FakeGateway implements PaymentGateway {
  readonly provider = 'FAKE';
  /** La simulada sí envía marca de tiempo: se prueba la ventana opcional de antigüedad. */
  readonly webhookMaxAgeSeconds = 300;
  private readonly secret = randomBytes(32);
  private readonly payments = new Map<string, FakePayment>();
  private readonly refunds = new Map<string, ProviderRefundState['status']>();
  private failures = 0;
  private unavailable = false;
  /** IMMEDIATE: el reembolso se confirma al pedirlo. ASYNC: llega luego por webhook. */
  refundMode: 'IMMEDIATE' | 'ASYNC' = 'ASYNC';

  constructor(@Optional() @Inject(CLOCK) private readonly clock: Clock = systemClock) {}

  // ───────────── Controles para pruebas ─────────────

  /** Las próximas `count` llamadas fallan (simula una caída puntual). */
  failNextCalls(count: number): void {
    this.failures = count;
  }

  /** Pasarela caída hasta que se vuelva a activar. */
  setUnavailable(value: boolean): void {
    this.unavailable = value;
  }

  /** Simula que el cliente terminó de pagar en la pasarela. Devuelve el webhook que se enviaría. */
  settlePayment(
    paymentId: string,
    outcome: 'SUCCEEDED' | 'REJECTED',
    overrides: Partial<FakeWebhookBody> = {},
  ): { rawBody: string; signature: string } {
    const payment = this.payments.get(paymentId) ?? {
      amount: overrides.amount ?? 0,
      currency: overrides.currency ?? 'PEN',
      status: 'PENDING' as const,
      transactionId: null,
    };
    payment.status = outcome === 'SUCCEEDED' ? 'PAID' : 'UNPAID';
    payment.transactionId = `fake_tx_${paymentId.slice(-12)}`;
    this.payments.set(paymentId, payment);
    return this.signedWebhook({
      eventId: `evt_${randomBytes(8).toString('hex')}`,
      kind: 'PAYMENT',
      paymentId,
      outcome,
      amount: payment.amount,
      currency: payment.currency,
      mode: 'TEST',
      transactionId: payment.transactionId,
      occurredAt: new Date(this.clock.now()).toISOString(),
      ...overrides,
    });
  }

  /** Simula el resultado de un reembolso pedido en modo ASYNC. */
  settleRefund(
    input: { refundId: string; paymentId: string; amount: number },
    outcome: 'SUCCEEDED' | 'FAILED',
  ): { rawBody: string; signature: string } {
    this.refunds.set(input.refundId, outcome);
    return this.signedWebhook({
      eventId: `evt_${randomBytes(8).toString('hex')}`,
      kind: 'REFUND',
      paymentId: input.paymentId,
      refundId: input.refundId,
      outcome,
      amount: input.amount,
      currency: 'PEN',
      mode: 'TEST',
      occurredAt: new Date(this.clock.now()).toISOString(),
    });
  }

  signedWebhook(body: FakeWebhookBody): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(body);
    return { rawBody, signature: this.sign(rawBody) };
  }

  sign(rawBody: string | Buffer): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  // ───────────── PaymentGateway ─────────────

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return this.call(() => {
      if (!this.payments.has(input.paymentId)) {
        this.payments.set(input.paymentId, {
          amount: input.amount,
          currency: input.currency,
          status: 'PENDING',
          transactionId: null,
        });
      }
      return {
        providerPaymentId: `fake_${digest(input.idempotencyKey)}`,
        clientAction: { type: 'FAKE', data: { paymentId: input.paymentId } },
      };
    });
  }

  getPayment(input: { paymentId: string }): Promise<ProviderPaymentState> {
    return this.call(() => {
      const payment = this.payments.get(input.paymentId);
      if (!payment) {
        return {
          status: 'NOT_FOUND',
          amount: null,
          currency: null,
          mode: null,
          providerTransactionId: null,
        };
      }
      return {
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        mode: 'TEST',
        providerTransactionId: payment.transactionId,
      };
    });
  }

  refund(input: RefundInput): Promise<RefundResult> {
    return this.call(() => {
      const status = this.refunds.get(input.refundId);
      if (!status || status === 'PENDING') {
        this.refunds.set(input.refundId, this.refundMode === 'IMMEDIATE' ? 'SUCCEEDED' : 'PENDING');
      }
      const current = this.refunds.get(input.refundId);
      return {
        providerRefundId: `fake_rf_${digest(input.idempotencyKey)}`,
        status: current === 'SUCCEEDED' ? 'SUCCEEDED' : 'PENDING',
      };
    });
  }

  getRefund(input: { refundId: string }): Promise<ProviderRefundState> {
    return this.call(() => ({ status: this.refunds.get(input.refundId) ?? 'NOT_FOUND' }));
  }

  parseWebhook(raw: RawWebhook): PaymentWebhookEvent {
    const body = this.verified(raw);
    return {
      providerEventId: body.eventId,
      kind: body.kind,
      paymentId: body.paymentId,
      refundId: body.refundId ?? null,
      outcome: body.outcome,
      amount: body.amount,
      currency: body.currency,
      mode: body.mode,
      providerTransactionId: body.transactionId ?? null,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : null,
      payload: {
        kind: body.kind,
        outcome: body.outcome,
        transactionId: body.transactionId ?? null,
      },
    };
  }

  verifyClientResult(raw: RawWebhook): { paymentId: string } {
    return { paymentId: this.verified(raw).paymentId };
  }

  private verified(raw: RawWebhook): FakeWebhookBody {
    const header = raw.headers[FAKE_SIGNATURE_HEADER];
    const received = typeof header === 'string' ? Buffer.from(header, 'hex') : Buffer.alloc(0);
    const expected = Buffer.from(this.sign(raw.rawBody), 'hex');
    // Comparación en tiempo constante, sobre el cuerpo exacto recibido.
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new InvalidSignatureError();
    }
    try {
      return JSON.parse(raw.rawBody.toString('utf8')) as FakeWebhookBody;
    } catch {
      throw new InvalidSignatureError();
    }
  }

  private call<T>(fn: () => T): Promise<T> {
    if (this.unavailable || this.failures > 0) {
      if (this.failures > 0) this.failures--;
      return Promise.reject(new PaymentGatewayError('FakeGateway: pasarela no disponible'));
    }
    return Promise.resolve(fn());
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
