import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type BillingGateway,
  BillingGatewayError,
  type BillingWebhookEvent,
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  type CreateSubscriptionInput,
  type CreateSubscriptionResult,
  InvalidBillingSignatureError,
  type ProviderSubscriptionState,
  type RawBillingWebhook,
} from './billing-gateway';

export const FAKE_BILLING_SIGNATURE_HEADER = 'x-fake-billing-signature';

interface FakeSubscription {
  reference: string;
  amount: number;
  currency: string;
  status: ProviderSubscriptionState['status'];
}

/**
 * Pasarela de facturación simulada (desarrollo y pruebas; nunca en producción). Guarda en memoria
 * el estado "del lado del proveedor" y firma los avisos con un secreto aleatorio por proceso.
 * Las pruebas generan avisos con `signedWebhook`.
 */
@Injectable()
export class FakeBillingGateway implements BillingGateway {
  readonly provider = 'FAKE';
  private readonly secret = randomBytes(32);
  private readonly subscriptions = new Map<string, FakeSubscription>();
  private readonly checkouts = new Map<string, { reference: string; amount: number }>();
  private seq = 0;
  /** Pruebas: simula la pasarela caída. */
  unavailable = false;

  async createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult> {
    if (this.unavailable) return this.down();
    const existing = [...this.subscriptions.entries()].find(
      ([, s]) => s.reference === input.reference,
    );
    const id = existing?.[0] ?? `fsub_${++this.seq}`;
    if (!existing) {
      this.subscriptions.set(id, {
        reference: input.reference,
        amount: input.amount,
        currency: input.currency,
        status: 'PENDING',
      });
    }
    return Promise.resolve({
      providerSubscriptionId: id,
      checkoutUrl: `https://fake.billing/subscriptions/${id}`,
    });
  }

  getSubscription(id: string): Promise<ProviderSubscriptionState> {
    if (this.unavailable) return this.down();
    const sub = this.subscriptions.get(id);
    return Promise.resolve(
      sub
        ? { status: sub.status, reference: sub.reference, nextPaymentAt: null }
        : { status: 'NOT_FOUND', reference: null, nextPaymentAt: null },
    );
  }

  cancelSubscription(id: string): Promise<void> {
    if (this.unavailable) return this.down();
    const sub = this.subscriptions.get(id);
    if (sub) sub.status = 'CANCELLED';
    return Promise.resolve();
  }

  updateSubscriptionAmount(id: string, amount: number): Promise<void> {
    if (this.unavailable) return this.down();
    const sub = this.subscriptions.get(id);
    if (sub) sub.amount = amount;
    return Promise.resolve();
  }

  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    if (this.unavailable) return this.down();
    const id = `fchk_${++this.seq}`;
    this.checkouts.set(id, { reference: input.reference, amount: input.amount });
    return Promise.resolve({
      providerCheckoutId: id,
      checkoutUrl: `https://fake.billing/checkout/${id}`,
    });
  }

  /** Pruebas: el pagador autorizó (o canceló) la suscripción en la pasarela. */
  setSubscriptionStatus(id: string, status: ProviderSubscriptionState['status']): void {
    const sub = this.subscriptions.get(id);
    if (sub) sub.status = status;
  }

  amountOf(id: string): number | null {
    return this.subscriptions.get(id)?.amount ?? null;
  }

  /** Pruebas: cuerpo y firma de un aviso. */
  signedWebhook(event: Exclude<BillingWebhookEvent, { kind: 'IGNORED' }>): {
    body: string;
    signature: string;
  } {
    const body = JSON.stringify(event);
    return { body, signature: this.sign(Buffer.from(body)) };
  }

  parseWebhook(raw: RawBillingWebhook): Promise<BillingWebhookEvent> {
    const header = raw.headers[FAKE_BILLING_SIGNATURE_HEADER];
    const received = typeof header === 'string' ? Buffer.from(header, 'hex') : Buffer.alloc(0);
    const expected = Buffer.from(this.sign(raw.rawBody), 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return Promise.reject(new InvalidBillingSignatureError());
    }
    try {
      const event = JSON.parse(raw.rawBody.toString('utf8')) as BillingWebhookEvent;
      if (event.kind === 'SUBSCRIPTION')
        this.setSubscriptionStatus(event.providerSubscriptionId, event.status);
      return Promise.resolve(event);
    } catch {
      return Promise.reject(new InvalidBillingSignatureError());
    }
  }

  private sign(body: Buffer): string {
    return createHmac('sha256', this.secret).update(body).digest('hex');
  }

  private down(): Promise<never> {
    return Promise.reject(new BillingGatewayError('Pasarela simulada caída'));
  }
}
