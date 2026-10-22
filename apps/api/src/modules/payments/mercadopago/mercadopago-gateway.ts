import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { APP_CONFIG } from '../../../common/config/app-config.token';
import type { AppConfig } from '../../../common/config/env.validation';
import { PAYMENTS_DONE_PATH } from '../checkout-pages';
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
} from '../payment-gateway';

export const MERCADOPAGO_PROVIDER = 'MERCADOPAGO';
/** Ruta (bajo /api/v1) del regreso desde Checkout Pro. */
export const MERCADOPAGO_RETURN_ROUTE = 'payments/mercadopago';
/** Vigencia de la preferencia (la reserva vence antes: 10 min por defecto). */
const PREFERENCE_TTL_MS = 30 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

/** Pago de Mercado Pago (`GET /v1/payments/{id}`), solo los campos que usa Charles. */
export interface MercadoPagoPayment {
  id: number | string;
  status?: string;
  status_detail?: string;
  transaction_amount?: number;
  currency_id?: string;
  external_reference?: string | null;
  live_mode?: boolean;
  payment_method_id?: string;
  payment_type_id?: string;
}

/**
 * Firma de los webhooks (`x-signature: ts=…,v1=…`): HMAC-SHA256 en hexadecimal, con la clave
 * secreta, del manifiesto `id:{data.id};request-id:{x-request-id};ts:{ts};` (se omite lo que
 * falta). Igual que `WebhookSignatureValidator` del SDK oficial de Node.
 */
export function mercadoPagoManifest(
  dataId: string | undefined,
  requestId: string | undefined,
  ts: string,
): string {
  const parts: string[] = [];
  if (dataId) parts.push(`id:${dataId}`);
  if (requestId) parts.push(`request-id:${requestId}`);
  parts.push(`ts:${ts}`);
  return `${parts.join(';')};`;
}

export function isValidMercadoPagoSignature(input: {
  signature: string | undefined;
  requestId: string | undefined;
  dataId: string | undefined;
  secret: string;
}): boolean {
  if (!input.signature) return false;
  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of input.signature.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value;
  }
  if (!ts || !/^\d+$/.test(ts) || !v1) return false;
  const expected = createHmac('sha256', input.secret)
    .update(mercadoPagoManifest(input.dataId, input.requestId, ts))
    .digest('hex');
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

/** Soles con decimales ↔ céntimos. */
export const toMercadoPagoAmount = (cents: number): number => Math.round(cents) / 100;
export const fromMercadoPagoAmount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100)
    : null;

/**
 * Adaptador de Mercado Pago (Checkout Pro, API de Preferences). Ver docs/mercadopago/referencia.md.
 *
 * - **Crear el pago:** una preferencia con `external_reference` = ID del pago en Charles y
 *   vencimiento; la app abre `init_point` en un WebView.
 * - **Webhook:** firma `x-signature`; el aviso no trae el monto, así que se **consulta el pago**
 *   (fuera de transacciones) y se normaliza. Solo `approved` confirma; pendiente (Yape), rechazado
 *   o cancelado no cambian la reserva (puede reintentar hasta que venza).
 * - **Modo:** `live_mode` de cada pago (en producción se rechazan los de prueba).
 */
@Injectable()
export class MercadoPagoGateway implements PaymentGateway {
  readonly provider = MERCADOPAGO_PROVIDER;
  /** El aviso trae `ts`, pero los reintentos de Mercado Pago no están documentados: idempotencia. */
  readonly webhookMaxAgeSeconds = null;
  private readonly logger = new Logger(MercadoPagoGateway.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get mp(): AppConfig['payments']['mercadoPago'] {
    return this.config.payments.mercadoPago;
  }

  private required(value: string | null, name: string): string {
    if (!value) throw new PaymentGatewayError(`Mercado Pago sin configurar: ${name}`);
    return value;
  }

  publicBaseUrl(): string {
    return this.required(this.config.payments.publicApiUrl, 'PUBLIC_API_URL');
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const base = this.publicBaseUrl();
    const back = (r: string) =>
      `${base}/api/v1/${MERCADOPAGO_RETURN_ROUTE}/return/${input.paymentId}?r=${r}`;
    const now = this.clock.now();
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
            id: input.paymentId,
            title: input.description.slice(0, 250) || 'Reserva Charles',
            quantity: 1,
            currency_id: input.currency,
            unit_price: toMercadoPagoAmount(input.amount),
          },
        ],
        external_reference: input.paymentId,
        // source_news=webhooks: solo webhooks firmados (sin las notificaciones IPN antiguas).
        notification_url: `${base}/api/v1/payments/webhooks/mercadopago?source_news=webhooks`,
        back_urls: { success: back('success'), pending: back('pending'), failure: back('failure') },
        auto_return: 'approved',
        expires: true,
        expiration_date_from: new Date(now).toISOString(),
        expiration_date_to: new Date(now + PREFERENCE_TTL_MS).toISOString(),
        statement_descriptor: 'CHARLES',
      },
      input.idempotencyKey,
    );
    const url = preference.init_point ?? preference.sandbox_init_point;
    if (!preference.id || !url)
      throw new PaymentGatewayError('Mercado Pago: preferencia sin enlace');
    return {
      providerPaymentId: preference.id,
      clientAction: {
        type: 'MERCADOPAGO_WEB',
        data: { paymentUrl: url, doneUrlPrefix: `${base}${PAYMENTS_DONE_PATH}` },
      },
    };
  }

  /** Busca los pagos del pedido por `external_reference` (base de la conciliación). */
  async getPayment(input: { paymentId: string }): Promise<ProviderPaymentState> {
    const query = new URLSearchParams({
      external_reference: input.paymentId,
      sort: 'date_created',
      criteria: 'desc',
    });
    const body = await this.request<{ results?: MercadoPagoPayment[] }>(
      'GET',
      `/v1/payments/search?${query.toString()}`,
    );
    const results = (body.results ?? []).filter((p) => p.external_reference === input.paymentId);
    const approved = results.find((p) => p.status === 'approved');
    const chosen = approved ?? results[0];
    if (!chosen) {
      return {
        status: 'PENDING',
        amount: null,
        currency: null,
        mode: null,
        providerTransactionId: null,
      };
    }
    const stillOpen = results.some((p) =>
      ['pending', 'in_process', 'authorized'].includes(p.status ?? ''),
    );
    return {
      status: approved ? 'PAID' : stillOpen ? 'PENDING' : 'UNPAID',
      amount: fromMercadoPagoAmount(chosen.transaction_amount),
      currency: chosen.currency_id ?? null,
      mode: chosen.live_mode === false ? 'TEST' : 'PRODUCTION',
      providerTransactionId: String(chosen.id),
      providerData: approved ? providerDataOf(approved) : undefined,
    };
  }

  /** Devolución total o parcial (`POST /v1/payments/{id}/refunds`), idempotente por clave. */
  async refund(input: RefundInput): Promise<RefundResult> {
    const mpPaymentId = input.providerData?.mpPaymentId;
    if (typeof mpPaymentId !== 'string' || !mpPaymentId) {
      throw new PaymentGatewayError('Mercado Pago: falta el pago aprobado para devolver');
    }
    const refund = await this.request<{ id?: number | string; status?: string }>(
      'POST',
      `/v1/payments/${encodeURIComponent(mpPaymentId)}/refunds`,
      { amount: toMercadoPagoAmount(input.amount) },
      input.idempotencyKey,
    );
    if (refund.id === undefined) throw new PaymentGatewayError('Mercado Pago: devolución sin id');
    return {
      providerRefundId: `${mpPaymentId}:${refund.id}`,
      status: refund.status === 'approved' ? 'SUCCEEDED' : 'PENDING',
    };
  }

  async getRefund(input: { providerRefundId: string | null }): Promise<ProviderRefundState> {
    const [paymentId, refundId] = (input.providerRefundId ?? '').split(':');
    if (!paymentId || !refundId) return { status: 'NOT_FOUND' };
    const refund = await this.request<{ status?: string } | null>(
      'GET',
      `/v1/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`,
      undefined,
      undefined,
      true,
    );
    if (!refund) return { status: 'NOT_FOUND' };
    if (refund.status === 'approved') return { status: 'SUCCEEDED' };
    if (refund.status === 'rejected' || refund.status === 'cancelled') return { status: 'FAILED' };
    return { status: 'PENDING' };
  }

  /** Webhook: verifica `x-signature` y consulta el pago notificado. */
  async parseWebhook(raw: RawWebhook): Promise<PaymentWebhookEvent> {
    const body = parseJson(raw.rawBody);
    const dataId = body?.data?.id === undefined ? undefined : String(body.data.id);
    const valid = isValidMercadoPagoSignature({
      signature: header(raw, 'x-signature'),
      requestId: header(raw, 'x-request-id'),
      dataId,
      secret: this.required(this.mp.webhookSecret, 'MERCADOPAGO_WEBHOOK_SECRET'),
    });
    if (!valid || !body || !dataId) throw new InvalidSignatureError();
    // Solo interesan los pagos; otros temas se reciben y se ignoran.
    if (body.type !== 'payment') return ignoredEvent(`${body.type ?? 'unknown'}:${dataId}`);
    const payment = await this.request<MercadoPagoPayment>(
      'GET',
      `/v1/payments/${encodeURIComponent(dataId)}`,
    );
    const amount = fromMercadoPagoAmount(payment.transaction_amount);
    // Sin referencia, o de facturación (`sub:`, `mem:`, `spk:`): no es el pago de una reserva.
    if (
      !payment.external_reference ||
      amount === null ||
      payment.external_reference.includes(':')
    ) {
      return ignoredEvent(`payment:${dataId}:${payment.status ?? ''}`);
    }
    const approved = payment.status === 'approved';
    return {
      // Cada cambio de estado de un pago se procesa una vez.
      providerEventId: `${payment.id}:${payment.status ?? ''}`,
      kind: 'PAYMENT',
      paymentId: payment.external_reference,
      providerPaymentId: null,
      refundId: null,
      outcome: approved ? 'SUCCEEDED' : 'FAILED',
      amount,
      currency: payment.currency_id ?? '',
      mode: payment.live_mode === false ? 'TEST' : 'PRODUCTION',
      providerTransactionId: String(payment.id),
      occurredAt: null,
      payload: {
        status: payment.status ?? null,
        statusDetail: payment.status_detail ?? null,
        paymentMethod: payment.payment_method_id ?? null,
      },
      providerData: approved ? providerDataOf(payment) : undefined,
    };
  }

  /** Checkout Pro no devuelve un resultado firmado a la app: se usa el regreso del servidor. */
  verifyClientResult(): never {
    throw new InvalidSignatureError();
  }

  // ───────────── HTTP ─────────────

  private async request<T>(
    method: 'GET' | 'POST',
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
      if (error instanceof PaymentGatewayError) throw error;
      throw new PaymentGatewayError(`Mercado Pago no respondió (${(error as Error).name})`);
    }
    if (notFoundAsNull && res.status === 404) return null as T;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new PaymentGatewayError(`Mercado Pago respondió ${res.status} sin JSON`);
    }
    if (!res.ok) {
      const code =
        (parsed as { error?: string; status?: number } | null)?.error ?? String(res.status);
      this.logger.warn(
        { path: path.split('?')[0], status: res.status, code },
        'Mercado Pago respondió con error',
      );
      throw new PaymentGatewayError(`Mercado Pago respondió ${res.status}`, code);
    }
    return parsed as T;
  }
}

interface WebhookBody {
  type?: string;
  action?: string;
  data?: { id?: string | number };
}

function parseJson(raw: Buffer): WebhookBody | null {
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function header(raw: RawWebhook, name: string): string | undefined {
  const value = raw.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : undefined;
}

/** Aviso auténtico que no afecta a ningún pago (otro tema o sin referencia). */
function ignoredEvent(providerEventId: string): PaymentWebhookEvent {
  return {
    providerEventId,
    kind: 'PAYMENT',
    paymentId: null,
    providerPaymentId: null,
    refundId: null,
    outcome: 'FAILED',
    amount: 0,
    currency: '',
    mode: 'PRODUCTION',
    providerTransactionId: null,
    occurredAt: null,
    payload: {},
    ignored: true,
  };
}

function providerDataOf(payment: MercadoPagoPayment): Record<string, string> {
  const data: Record<string, string> = { mpPaymentId: String(payment.id) };
  if (payment.payment_method_id) data.paymentMethod = payment.payment_method_id;
  if (payment.payment_type_id) data.paymentType = payment.payment_type_id;
  return data;
}
