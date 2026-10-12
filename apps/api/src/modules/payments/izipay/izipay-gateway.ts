import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { APP_CONFIG } from '../../../common/config/app-config.token';
import { type AppConfig, IzipayMode } from '../../../common/config/env.validation';
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
import {
  fromIzipayAmount,
  IZIPAY_SUCCESS,
  type IzipaySignedEnvelope,
  type IzipaySignedPayload,
  izipayOrderNumber,
  openSignedEnvelope,
  toIzipayAmount,
} from './izipay-protocol';

export const IZIPAY_PROVIDER = 'IZIPAY';
/** Ruta (bajo /api/v1) de la página de pago y del regreso del formulario. */
export const IZIPAY_CHECKOUT_ROUTE = 'payments/izipay';
/** Vigencia del enlace de la página de pago (la reserva vence antes: 10 min por defecto). */
const CHECKOUT_LINK_TTL_MS = 30 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

/** Lo que la página de pago necesita para cargar el formulario de Izipay. */
export interface IzipayCheckoutSession {
  token: string;
  transactionId: string;
  orderNumber: string;
  merchantCode: string;
  publicKey: string;
  amount: string;
  currency: string;
  scriptUrl: string;
  urlIPN: string;
  mode: IzipayMode;
}

interface IzipayEnvelope<T> {
  code?: string;
  message?: string;
  response?: T;
}

/**
 * Adaptador de Izipay (Fase 8B): botón de pagos de developers.izipay.pe, con el formulario web
 * (tarjeta y Yape) abierto por la app en un WebView. Ver docs/izipay/referencia.md.
 *
 * - **Pedido:** número de 15 caracteres derivado de la clave de idempotencia (se guarda como
 *   `providerPaymentId`). Izipay devuelve ese número, no el UUID de Charles.
 * - **Firma:** HMAC-SHA256 de `payloadHttp` con la clave hash; solo se leen datos firmados.
 * - **Rechazos:** un pago no aprobado se informa como `FAILED`: la reserva sigue pendiente y el
 *   cliente puede reintentar con otro medio hasta que venza (no se cancela por una tarjeta
 *   rechazada).
 * - **Modo:** Izipay no lo informa por pago; es el de la configuración (en producción la app no
 *   arranca en modo TEST).
 * - Nunca se llama dentro de una transacción de base de datos.
 */
@Injectable()
export class IzipayGateway implements PaymentGateway {
  readonly provider = IZIPAY_PROVIDER;
  /** Izipay no envía marca de tiempo en la notificación: protección por idempotencia y firma. */
  readonly webhookMaxAgeSeconds = null;
  private readonly logger = new Logger(IzipayGateway.name);
  private readonly linkKey: Buffer;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    // Clave propia de los enlaces de pago, derivada (nunca la misma que otra).
    this.linkKey = createHmac('sha256', config.crypto.blindIndexKey)
      .update('izipay-checkout-link')
      .digest();
  }

  private get izipay(): AppConfig['payments']['izipay'] {
    return this.config.payments.izipay;
  }

  private get mode(): 'TEST' | 'PRODUCTION' {
    return this.izipay.mode === IzipayMode.Production ? 'PRODUCTION' : 'TEST';
  }

  private required(value: string | null, name: string): string {
    if (!value) throw new PaymentGatewayError(`Izipay sin configurar: ${name}`);
    return value;
  }

  private get publicApiUrl(): string {
    return this.required(this.config.payments.publicApiUrl, 'PUBLIC_API_URL');
  }

  /** URL pública de la API (sin `/api/v1`). */
  publicBaseUrl(): string {
    return this.publicApiUrl;
  }

  // ───────────── Enlace firmado de la página de pago ─────────────

  checkoutUrl(paymentId: string): string {
    const expires = this.clock.now() + CHECKOUT_LINK_TTL_MS;
    const signature = this.linkSignature(paymentId, expires);
    return `${this.publicApiUrl}/api/v1/${IZIPAY_CHECKOUT_ROUTE}/checkout/${paymentId}?e=${expires}&s=${signature}`;
  }

  /** Enlace auténtico y vigente: solo quien recibió la URL abre la página de ese pago. */
  isValidCheckoutLink(paymentId: string, expires: unknown, signature: unknown): boolean {
    const exp = typeof expires === 'string' ? Number(expires) : NaN;
    if (!Number.isSafeInteger(exp) || exp < this.clock.now() || typeof signature !== 'string') {
      return false;
    }
    const expected = Buffer.from(this.linkSignature(paymentId, exp));
    const received = Buffer.from(signature);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private linkSignature(paymentId: string, expires: number): string {
    return createHmac('sha256', this.linkKey).update(`${paymentId}.${expires}`).digest('base64url');
  }

  // ───────────── PaymentGateway ─────────────

  /**
   * Izipay no tiene un "crear pago" previo: el token de sesión dura 15 minutos y es de un solo
   * uso, así que se pide al abrir la página (`checkoutSession`). Aquí solo se fija el pedido y se
   * arma el enlace. No llama a Izipay.
   */
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    try {
      return Promise.resolve({
        providerPaymentId: izipayOrderNumber(input.idempotencyKey),
        clientAction: {
          type: 'IZIPAY_WEB',
          data: {
            paymentUrl: this.checkoutUrl(input.paymentId),
            doneUrlPrefix: `${this.publicApiUrl}${PAYMENTS_DONE_PATH}`,
          },
        },
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Token de sesión para cargar el formulario (cada carga de la página pide uno nuevo). */
  async checkoutSession(input: {
    orderNumber: string;
    amount: number;
    currency: string;
  }): Promise<IzipayCheckoutSession> {
    const transactionId = this.newTransactionId();
    const amount = toIzipayAmount(input.amount);
    const token = await this.sessionToken('ECOMMERCE', transactionId, input.orderNumber, amount);
    return {
      token,
      transactionId,
      orderNumber: input.orderNumber,
      merchantCode: this.required(this.izipay.merchantCode, 'IZIPAY_MERCHANT_CODE'),
      publicKey: this.required(this.izipay.publicKey, 'IZIPAY_PUBLIC_KEY'),
      amount,
      currency: input.currency,
      scriptUrl: this.izipay.checkoutScriptUrl,
      urlIPN: `${this.publicApiUrl}/api/v1/payments/webhooks/izipay`,
      mode: this.izipay.mode,
    };
  }

  /** Consulta del pedido (`/orderinfo/v1/Transaction/Search`): base de la conciliación. */
  async getPayment(input: {
    paymentId: string;
    providerPaymentId: string | null;
  }): Promise<ProviderPaymentState> {
    const notFound: ProviderPaymentState = {
      status: 'NOT_FOUND',
      amount: null,
      currency: null,
      mode: null,
      providerTransactionId: null,
    };
    if (!input.providerPaymentId) return notFound;
    const transactionId = this.newTransactionId();
    const token = await this.sessionToken(
      'ECOMMERCE',
      transactionId,
      input.providerPaymentId,
      '0.00',
    );
    const body = await this.post<IzipaySignedEnvelope & IzipayEnvelope<unknown>>(
      '/orderinfo/v1/Transaction/Search',
      transactionId,
      token,
      {
        merchantCode: this.required(this.izipay.merchantCode, 'IZIPAY_MERCHANT_CODE'),
        numberOrden: input.providerPaymentId,
        language: 'ESP',
      },
    );
    if (body.code !== IZIPAY_SUCCESS) {
      // Pedido sin pagos registrados (o aún en curso): nada que aplicar.
      return { ...notFound, status: 'PENDING' };
    }
    const signed = openSignedEnvelope(body, this.hashKey());
    if (!signed) throw new PaymentGatewayError('Izipay: respuesta de consulta sin firma válida');
    const order = signed.response?.order?.find((o) => o.orderNumber === input.providerPaymentId);
    if (!order) return notFound;
    const approved = signed.code === IZIPAY_SUCCESS;
    return {
      status: approved ? 'PAID' : 'UNPAID',
      amount: fromIzipayAmount(order.amount),
      currency: order.currency ?? null,
      mode: this.mode,
      providerTransactionId: order.uniqueId ?? null,
      providerData: approved ? providerDataOf(signed) : undefined,
    };
  }

  /**
   * Devolución total o parcial (`/refund/v1/Transaction/Refund`). Solo funciona en producción
   * (Izipay no la ofrece en pruebas). Exige el RUC del comercio y los datos del pago aprobado.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    const data = input.providerData ?? {};
    const uniqueId = typeof data.uniqueId === 'string' ? data.uniqueId : null;
    const codeAuth = typeof data.codeAuth === 'string' ? data.codeAuth : null;
    const referenceNumber = typeof data.referenceNumber === 'string' ? data.referenceNumber : null;
    if (!uniqueId || !codeAuth || !referenceNumber || !input.providerPaymentId) {
      throw new PaymentGatewayError('Izipay: faltan los datos del pago para devolver');
    }
    const transactionId = this.newTransactionId();
    const amount = toIzipayAmount(input.amount);
    const token = await this.sessionToken('REFUND', transactionId, input.providerPaymentId, amount);
    const body = await this.post<
      IzipayEnvelope<{ result?: { refundTransactionId?: string } }> & { message?: string }
    >('/refund/v1/Transaction/Refund', transactionId, token, {
      merchantCode: this.required(this.izipay.merchantCode, 'IZIPAY_MERCHANT_CODE'),
      ruc: this.required(this.izipay.ruc, 'IZIPAY_RUC'),
      idUnique: uniqueId,
      order: {
        authorizationCode: codeAuth,
        referenceNumber,
        currency: input.currency,
        refundAmount: amount,
        totalAmount: '',
        transactionDate: '',
      },
      card: { brand: '', firstSixDigits: '', lastFourDigits: '' },
      language: 'ESP',
    });
    const refundId = body.response?.result?.refundTransactionId;
    if (body.code !== IZIPAY_SUCCESS || !refundId) {
      throw new PaymentGatewayError('Izipay: devolución no registrada', body.code ?? null);
    }
    // Registrada: el resultado final se consulta después (conciliación de reembolsos).
    return { providerRefundId: refundId, status: 'PENDING' };
  }

  /** Estado de una devolución (`/refund/v1/refunds/status`). */
  async getRefund(input: {
    refundId: string;
    providerRefundId: string | null;
  }): Promise<ProviderRefundState> {
    if (!input.providerRefundId) return { status: 'NOT_FOUND' };
    const transactionId = this.newTransactionId();
    const token = await this.sessionToken('REFUND', transactionId, 'REFUND00000', '0.00');
    const query = new URLSearchParams({
      refundId: input.providerRefundId,
      merchantCode: this.required(this.izipay.merchantCode, 'IZIPAY_MERCHANT_CODE'),
      language: 'ESP',
    });
    const body = await this.request<
      IzipayEnvelope<{ statusName?: string | null; rejectionReason?: string | null }>
    >('GET', `/refund/v1/refunds/status?${query.toString()}`, transactionId, token);
    if (body.code === 'N01') return { status: 'NOT_FOUND' };
    if (body.code !== IZIPAY_SUCCESS) return { status: 'PENDING' };
    return { status: refundStatusOf(body.response?.statusName) };
  }

  /** Notificación (IPN): JSON con `payloadHttp` y `signature` (HMAC con la clave hash). */
  parseWebhook(raw: RawWebhook): PaymentWebhookEvent {
    const envelope = parseJson(raw.rawBody);
    const signed = envelope ? openSignedEnvelope(envelope, this.hashKey()) : null;
    const order = signed?.response?.order?.[0];
    const amount = fromIzipayAmount(order?.amount);
    if (!signed || !order?.orderNumber || amount === null) throw new InvalidSignatureError();
    const approved = signed.code === IZIPAY_SUCCESS;
    return {
      // Un mismo aviso reenviado trae el mismo transactionId y resultado: idempotente.
      providerEventId: `${signed.transactionId ?? envelope?.transactionId ?? ''}:${order.orderNumber}:${signed.code ?? ''}`,
      kind: 'PAYMENT',
      paymentId: null,
      providerPaymentId: order.orderNumber,
      refundId: null,
      outcome: approved ? 'SUCCEEDED' : 'FAILED',
      amount,
      currency: order.currency ?? '',
      mode: this.mode,
      providerTransactionId: order.uniqueId ?? null,
      occurredAt: null,
      payload: {
        code: signed.code ?? null,
        payMethod: order.payMethodAuthorization ?? signed.response?.payMethod ?? null,
        stateMessage: order.stateMessage ?? null,
        uniqueId: order.uniqueId ?? null,
      },
      providerData: approved ? providerDataOf(signed) : undefined,
    };
  }

  /** Resultado que devuelve el formulario (regreso o app): mismo sobre firmado que la IPN. */
  verifyClientResult(raw: RawWebhook): { paymentId: null; providerPaymentId: string } {
    const envelope = parseJson(raw.rawBody);
    return this.verifyEnvelope(envelope ?? {});
  }

  /** Verifica un sobre firmado ya decodificado (regreso del formulario en x-www-form-urlencoded). */
  verifyEnvelope(envelope: IzipaySignedEnvelope | Record<string, unknown>): {
    paymentId: null;
    providerPaymentId: string;
  } {
    const signed = openSignedEnvelope(envelope, this.hashKey());
    const orderNumber = signed?.response?.order?.[0]?.orderNumber;
    if (!signed || !orderNumber) throw new InvalidSignatureError();
    return { paymentId: null, providerPaymentId: orderNumber };
  }

  // ───────────── HTTP ─────────────

  private hashKey(): string {
    return this.required(this.izipay.hashKey, 'IZIPAY_HASH_KEY');
  }

  /** transactionId: 5–40 caracteres, único por operación (milisegundos + aleatorio). */
  private newTransactionId(): string {
    return `${this.clock.now()}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
  }

  /** Token de sesión (`/security/v1/Token/Generate`), válido 15 minutos y para un solo uso. */
  private async sessionToken(
    requestSource: 'ECOMMERCE' | 'REFUND',
    transactionId: string,
    orderNumber: string,
    amount: string,
  ): Promise<string> {
    const body = await this.request<IzipayEnvelope<{ token?: string }>>(
      'POST',
      '/security/v1/Token/Generate',
      transactionId,
      null,
      {
        requestSource,
        merchantCode: this.required(this.izipay.merchantCode, 'IZIPAY_MERCHANT_CODE'),
        orderNumber,
        publicKey: this.required(this.izipay.apiKey, 'IZIPAY_API_KEY'),
        amount,
      },
    );
    const token = body.response?.token;
    if (body.code !== IZIPAY_SUCCESS || !token) {
      throw new PaymentGatewayError('Izipay: no se pudo generar el token', body.code ?? null);
    }
    return token;
  }

  private post<T>(path: string, transactionId: string, token: string, body: object): Promise<T> {
    return this.request<T>('POST', path, transactionId, token, body);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    transactionId: string,
    token: string | null,
    body?: object,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.izipay.apiUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          transactionId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PaymentGatewayError(`Izipay no respondió (${(error as Error).name})`);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new PaymentGatewayError(`Izipay respondió ${res.status} sin JSON`);
    }
    if (res.status >= 500 || res.status === 401 || res.status === 429) {
      const code = (parsed as { code?: string } | null)?.code ?? String(res.status);
      this.logger.warn({ path, status: res.status, code }, 'Izipay respondió con error');
      throw new PaymentGatewayError(`Izipay respondió ${res.status}`, code);
    }
    return parsed as T;
  }
}

function parseJson(raw: Buffer): IzipaySignedEnvelope | null {
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Lo necesario para una devolución. Nunca datos de tarjeta. */
function providerDataOf(signed: IzipaySignedPayload): Record<string, string> {
  const order = signed.response?.order?.[0];
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    uniqueId: order?.uniqueId,
    codeAuth: order?.codeAuth,
    referenceNumber: order?.referenceNumber,
    payMethod: order?.payMethodAuthorization ?? signed.response?.payMethod,
  })) {
    if (typeof value === 'string' && value.length > 0) data[key] = value;
  }
  return data;
}

/** `statusName` de Izipay → estado de Charles. Desconocido = sigue pendiente (se reconsulta). */
export function refundStatusOf(
  statusName: string | null | undefined,
): ProviderRefundState['status'] {
  const name = (statusName ?? '').toUpperCase();
  if (/AUTORIZAD|APROBAD|PROCESAD|COMPLETAD|EXITOS/.test(name)) return 'SUCCEEDED';
  if (/RECHAZ|DENEGAD|ANULAD|FALLID|ERROR/.test(name)) return 'FAILED';
  return 'PENDING';
}
