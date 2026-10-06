import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CreatePaymentInput, CreatePaymentResult, PaymentGateway } from './payment-gateway';

/**
 * Pasarela simulada (desarrollo y pruebas). Idempotente por `idempotencyKey`: la misma clave da
 * siempre el mismo `providerPaymentId`. Nunca se permite en producción (PaymentsProviderCheck).
 */
@Injectable()
export class FakeGateway implements PaymentGateway {
  readonly provider = 'FAKE';
  private failures = 0;

  /** Solo pruebas: las próximas `count` llamadas fallan (simula una caída de la pasarela). */
  failNextCalls(count: number): void {
    this.failures = count;
  }

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error('FakeGateway: fallo simulado'));
    }
    const digest = createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24);
    return Promise.resolve({
      providerPaymentId: `fake_${digest}`,
      clientAction: { type: 'FAKE', data: { paymentId: input.paymentId } },
    });
  }
}
