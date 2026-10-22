/**
 * Pasarela de facturación de Charles (Fases 15 y 16): cobros **recurrentes** (planes de las
 * barberías y membresías de clientes) y cobros únicos (paquetes de auspiciadores). Está separada
 * de `PaymentGateway`, que cobra reservas.
 *
 * - La referencia (`reference`) identifica qué se cobra: `sub:<id>` (suscripción), `mem:<id>`
 *   (membresía) o `spk:<id>` (compra de paquete).
 * - Ninguna llamada a la pasarela ocurre dentro de una transacción de base de datos.
 */

export const BILLING_GATEWAY = Symbol('BILLING_GATEWAY');

/** La pasarela no respondió o respondió con error: reintentable. */
export class BillingGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingGatewayError';
  }
}

export type BillingReferenceKind = 'sub' | 'mem' | 'spk';

export const billingReference = (kind: BillingReferenceKind, id: string): string => `${kind}:${id}`;

export function parseBillingReference(
  reference: string | null | undefined,
): { kind: BillingReferenceKind; id: string } | null {
  const match = /^(sub|mem|spk):([0-9a-f-]{36})$/.exec(reference ?? '');
  return match ? { kind: match[1] as BillingReferenceKind, id: match[2]! } : null;
}

export interface CreateSubscriptionInput {
  reference: string;
  /** Lo que verá el pagador en la pasarela ("Plan Pro de Charles"). */
  reason: string;
  /** Céntimos por periodo. */
  amount: number;
  currency: string;
  frequencyMonths: 1 | 12;
  trialDays: number;
  payerEmail: string;
  /** A dónde vuelve el pagador al terminar. */
  backUrl: string;
  idempotencyKey: string;
}

export interface CreateSubscriptionResult {
  providerSubscriptionId: string;
  checkoutUrl: string;
}

export type ProviderSubscriptionStatus =
  'PENDING' | 'AUTHORIZED' | 'PAUSED' | 'CANCELLED' | 'NOT_FOUND';

export interface ProviderSubscriptionState {
  status: ProviderSubscriptionStatus;
  reference: string | null;
  nextPaymentAt: Date | null;
}

export interface CreateCheckoutInput {
  reference: string;
  title: string;
  amount: number;
  currency: string;
  backUrl: string;
  idempotencyKey: string;
}

export interface CreateCheckoutResult {
  providerCheckoutId: string;
  checkoutUrl: string;
}

export type BillingPaymentOutcome = 'PAID' | 'FAILED' | 'PENDING';

/** Aviso verificado y normalizado. */
export type BillingWebhookEvent =
  | {
      kind: 'SUBSCRIPTION';
      providerEventId: string;
      providerSubscriptionId: string;
      reference: string | null;
      status: ProviderSubscriptionStatus;
    }
  | {
      kind: 'SUBSCRIPTION_PAYMENT' | 'PAYMENT';
      providerEventId: string;
      providerSubscriptionId: string | null;
      reference: string | null;
      providerPaymentId: string;
      outcome: BillingPaymentOutcome;
      amount: number;
      currency: string;
      failureReason: string | null;
    }
  | { kind: 'IGNORED'; providerEventId: string };

export interface RawBillingWebhook {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface BillingGateway {
  readonly provider: string;
  createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult>;
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionState>;
  cancelSubscription(providerSubscriptionId: string): Promise<void>;
  /** Cambio de precio: aplica desde el próximo cobro. */
  updateSubscriptionAmount(
    providerSubscriptionId: string,
    amount: number,
    currency: string,
  ): Promise<void>;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /** Verifica la firma (lanza `InvalidBillingSignatureError`) y normaliza. Fuera de transacciones. */
  parseWebhook(raw: RawBillingWebhook): Promise<BillingWebhookEvent>;
}

export class InvalidBillingSignatureError extends Error {
  constructor() {
    super('Firma inválida');
    this.name = 'InvalidBillingSignatureError';
  }
}

/** Suma de meses en UTC (el día se ajusta al último del mes si hace falta). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export const DAY_MS = 86_400_000;
