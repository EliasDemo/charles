import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import {
  fromMercadoPagoAmount,
  isValidMercadoPagoSignature,
  toMercadoPagoAmount,
} from '../payments/mercadopago/mercadopago-gateway';
import {
  type BillingGateway,
  BillingGatewayError,
  type BillingWebhookEvent,
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  type CreateSubscriptionInput,
  type CreateSubscriptionResult,
  InvalidBillingSignatureError,
  parseBillingReference,
  type ProviderSubscriptionState,
  type ProviderSubscriptionStatus,
  type RawBillingWebhook,
} from './billing-gateway';

const HTTP_TIMEOUT_MS = 15_000;
/** Ruta (bajo /api/v1) de los avisos de facturación. */
export const BILLING_WEBHOOK_ROUTE = 'billing/webhooks/mercadopago';

interface Preapproval {
  id?: string;
  status?: string;
  external_reference?: string | null;
  init_point?: string;
  sandbox_init_point?: string;
  next_payment_date?: string | null;
}

interface AuthorizedPayment {
  id?: number | string;
  preapproval_id?: string;
  status?: string;
  transaction_amount?: number;
  currency_id?: string;
  rejection_code?: string | null;
  payment?: { id?: number | string; status?: string; status_detail?: string } | null;
}

interface MpPayment {
  id: number | string;
  status?: string;
  status_detail?: string;
  transaction_amount?: number;
  currency_id?: string;
  external_reference?: string | null;
}

/**
 * Mercado Pago para facturación (documentación oficial de Suscripciones, disponible en Perú):
 *
 * - **Recurrentes:** `POST /preapproval` sin plan asociado (`status: pending`): el pagador abre
 *   `init_point` y autoriza el cobro con tarjeta o Yape. Mercado Pago cobra cada periodo y
 *   reintenta solo si falla.
 * - **Únicos:** preferencia de Checkout Pro (paquetes de auspiciadores).
 * - **Avisos:** mismos webhooks firmados (`x-signature`) que los pagos de reservas. Temas
 *   `subscription_preapproval`, `subscription_authorized_payment` y `payment`. El aviso no trae el
 *   detalle: se consulta a la API (fuera de transacciones).
 */
@Injectable()
export class MercadoPagoBillingGateway implements BillingGateway {
  readonly provider = 'MERCADOPAGO';
  private readonly logger = new Logger(MercadoPagoBillingGateway.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private get mp(): AppConfig['payments']['mercadoPago'] {
    return this.config.payments.mercadoPago;
  }

  private required(value: string | null, name: string): string {
    if (!value) throw new BillingGatewayError(`Mercado Pago sin configurar: ${name}`);
    return value;
  }

  private notificationUrl(): string {
    const base = this.required(this.config.payments.publicApiUrl, 'PUBLIC_API_URL');
    return `${base}/api/v1/${BILLING_WEBHOOK_ROUTE}?source_news=webhooks`;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult> {
    const body = await this.request<Preapproval>(
      'POST',
      '/preapproval',
      {
        reason: input.reason.slice(0, 250),
        external_reference: input.reference,
        payer_email: input.payerEmail,
        back_url: input.backUrl,
        notification_url: this.notificationUrl(),
        status: 'pending',
        auto_recurring: {
          frequency: input.frequencyMonths,
          frequency_type: 'months',
          transaction_amount: toMercadoPagoAmount(input.amount),
          currency_id: input.currency,
          ...(input.trialDays > 0
            ? { free_trial: { frequency: input.trialDays, frequency_type: 'days' } }
            : {}),
        },
      },
      input.idempotencyKey,
    );
    const url = body.init_point ?? body.sandbox_init_point;
    if (!body.id || !url) throw new BillingGatewayError('Mercado Pago: suscripción sin enlace');
    return { providerSubscriptionId: body.id, checkoutUrl: url };
  }

  async getSubscription(id: string): Promise<ProviderSubscriptionState> {
    const body = await this.request<Preapproval | null>(
      'GET',
      `/preapproval/${encodeURIComponent(id)}`,
      undefined,
      undefined,
      true,
    );
    if (!body) return { status: 'NOT_FOUND', reference: null, nextPaymentAt: null };
    return {
      status: subscriptionStatus(body.status),
      reference: body.external_reference ?? null,
      nextPaymentAt: body.next_payment_date ? new Date(body.next_payment_date) : null,
    };
  }

  async cancelSubscription(id: string): Promise<void> {
    await this.request('PUT', `/preapproval/${encodeURIComponent(id)}`, { status: 'cancelled' });
  }

  async updateSubscriptionAmount(id: string, amount: number, currency: string): Promise<void> {
    await this.request('PUT', `/preapproval/${encodeURIComponent(id)}`, {
      auto_recurring: { transaction_amount: toMercadoPagoAmount(amount), currency_id: currency },
    });
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const preference = await this.request<{
      id?: string;
      init_point?: string;
      sandbox_init_point?: string;
    }>(
      'POST',
      '/checkout/preferences',
      {
        items: [
          {
            id: input.reference,
            title: input.title.slice(0, 250),
            quantity: 1,
            currency_id: input.currency,
            unit_price: toMercadoPagoAmount(input.amount),
          },
        ],
        external_reference: input.reference,
        notification_url: this.notificationUrl(),
        back_urls: { success: input.backUrl, pending: input.backUrl, failure: input.backUrl },
        statement_descriptor: 'CHARLES',
      },
      input.idempotencyKey,
    );
    const url = preference.init_point ?? preference.sandbox_init_point;
    if (!preference.id || !url) throw new BillingGatewayError('Mercado Pago: cobro sin enlace');
    return { providerCheckoutId: preference.id, checkoutUrl: url };
  }

  async parseWebhook(raw: RawBillingWebhook): Promise<BillingWebhookEvent> {
    const body = parseBody(raw.rawBody);
    const dataId = body?.data?.id === undefined ? undefined : String(body.data.id);
    const valid = isValidMercadoPagoSignature({
      signature: header(raw, 'x-signature'),
      requestId: header(raw, 'x-request-id'),
      dataId,
      secret: this.required(this.mp.webhookSecret, 'MERCADOPAGO_WEBHOOK_SECRET'),
    });
    if (!valid || !body || !dataId) throw new InvalidBillingSignatureError();

    switch (body.type) {
      case 'subscription_preapproval': {
        const state = await this.getSubscription(dataId);
        if (state.status === 'NOT_FOUND')
          return { kind: 'IGNORED', providerEventId: `pre:${dataId}` };
        return {
          kind: 'SUBSCRIPTION',
          providerEventId: `pre:${dataId}:${state.status}`,
          providerSubscriptionId: dataId,
          reference: state.reference,
          status: state.status,
        };
      }
      case 'subscription_authorized_payment': {
        const ap = await this.request<AuthorizedPayment>(
          'GET',
          `/authorized_payments/${encodeURIComponent(dataId)}`,
        );
        const preapprovalId = ap.preapproval_id ?? null;
        const reference = preapprovalId
          ? (await this.getSubscription(preapprovalId)).reference
          : null;
        const amount = fromMercadoPagoAmount(ap.transaction_amount);
        if (!preapprovalId || amount === null) {
          return { kind: 'IGNORED', providerEventId: `ap:${dataId}` };
        }
        const paymentStatus = ap.payment?.status;
        const outcome =
          paymentStatus === 'approved'
            ? 'PAID'
            : paymentStatus === 'rejected' || ap.status === 'recycling' || ap.status === 'cancelled'
              ? 'FAILED'
              : 'PENDING';
        return {
          kind: 'SUBSCRIPTION_PAYMENT',
          providerEventId: `ap:${dataId}:${outcome}`,
          providerSubscriptionId: preapprovalId,
          reference,
          providerPaymentId: String(ap.payment?.id ?? `ap-${dataId}`),
          outcome,
          amount,
          currency: ap.currency_id ?? 'PEN',
          failureReason: ap.payment?.status_detail ?? ap.rejection_code ?? null,
        };
      }
      case 'payment': {
        const payment = await this.request<MpPayment>(
          'GET',
          `/v1/payments/${encodeURIComponent(dataId)}`,
        );
        const ref = parseBillingReference(payment.external_reference);
        const amount = fromMercadoPagoAmount(payment.transaction_amount);
        // Pagos de reservas (o sin referencia de facturación): los procesa el módulo de pagos.
        if (!ref || amount === null) return { kind: 'IGNORED', providerEventId: `pay:${dataId}` };
        const outcome =
          payment.status === 'approved'
            ? 'PAID'
            : payment.status === 'rejected' || payment.status === 'cancelled'
              ? 'FAILED'
              : 'PENDING';
        return {
          kind: 'PAYMENT',
          providerEventId: `pay:${payment.id}:${payment.status ?? ''}`,
          providerSubscriptionId: null,
          reference: payment.external_reference ?? null,
          providerPaymentId: String(payment.id),
          outcome,
          amount,
          currency: payment.currency_id ?? 'PEN',
          failureReason: payment.status_detail ?? null,
        };
      }
      default:
        return { kind: 'IGNORED', providerEventId: `${body.type ?? 'unknown'}:${dataId}` };
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: object,
    idempotencyKey?: string,
    notFoundAsNull = false,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.mp.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.required(this.mp.accessToken, 'MERCADOPAGO_ACCESS_TOKEN')}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof BillingGatewayError) throw error;
      throw new BillingGatewayError(`Mercado Pago no respondió (${(error as Error).name})`);
    }
    if (notFoundAsNull && res.status === 404) return null as T;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new BillingGatewayError(`Mercado Pago respondió ${res.status} sin JSON`);
    }
    if (!res.ok) {
      this.logger.warn(
        { path: path.split('?')[0], status: res.status },
        'Mercado Pago (facturación) respondió con error',
      );
      throw new BillingGatewayError(`Mercado Pago respondió ${res.status}`);
    }
    return parsed as T;
  }
}

interface WebhookBody {
  type?: string;
  data?: { id?: string | number };
}

function parseBody(raw: Buffer): WebhookBody | null {
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function subscriptionStatus(status: string | undefined): ProviderSubscriptionStatus {
  switch (status) {
    case 'authorized':
      return 'AUTHORIZED';
    case 'paused':
      return 'PAUSED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

function header(raw: RawBillingWebhook, name: string): string | undefined {
  const value = raw.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : undefined;
}
