/**
 * Pasarela de pagos (CLAUDE.md §4.2, ADR 0002): la aplicación solo conoce esta interfaz.
 * Hoy existe `FakeGateway`; el adaptador de Izipay (micuentaweb) llega en la Fase 8B.
 *
 * Diseñada para ser compatible con Izipay (docs/izipay/referencia.md):
 * - Los errores del proveedor no llegan como código HTTP (Izipay responde siempre 200 y el
 *   resultado va en `status`): el adaptador los traduce a `PaymentGatewayError`.
 * - `parseWebhook` y `verifyClientResult` reciben el cuerpo **sin procesar**: la firma se calcula
 *   sobre el texto exacto.
 * - Los eventos normalizados traen importe, moneda, modo y el ID de transacción del proveedor,
 *   para validar antes de confirmar.
 *
 * Regla: ninguna llamada a la pasarela ocurre dentro de una transacción de base de datos.
 */

/** Modo del proveedor. En producción se rechaza todo resultado en modo TEST. */
export type ProviderMode = 'TEST' | 'PRODUCTION';

/** Error de la pasarela (caída, tiempo agotado o respuesta `status = ERROR`). Reintentable. */
export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    /** Código del proveedor, por ejemplo `INT_902` en Izipay; null si no hubo respuesta. */
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}

/** Firma inválida o mensaje mal formado: nunca se procesa. */
export class InvalidSignatureError extends Error {
  constructor() {
    super('Firma inválida');
    this.name = 'InvalidSignatureError';
  }
}

export interface CreatePaymentInput {
  /** ID del pago en Charles. Es la referencia del pedido en la pasarela (`orderId` en Izipay). */
  paymentId: string;
  amount: number;
  currency: string;
  /** Misma clave = mismo cobro en la pasarela: permite reintentar sin cobrar dos veces. */
  idempotencyKey: string;
  description: string;
}

/** Lo que la app necesita para que el cliente pague (Izipay: formToken, clave pública y servidor). */
export interface ClientPaymentAction {
  type: 'FAKE' | 'IZIPAY_SDK';
  data: Record<string, string>;
}

export interface CreatePaymentResult {
  providerPaymentId: string;
  clientAction: ClientPaymentAction;
}

/** Estado de un pago según la pasarela (consulta directa; base de la conciliación). */
export interface ProviderPaymentState {
  status: 'PAID' | 'UNPAID' | 'PENDING' | 'NOT_FOUND';
  amount: number | null;
  currency: string | null;
  mode: ProviderMode | null;
  providerTransactionId: string | null;
}

export interface RefundInput {
  refundId: string;
  paymentId: string;
  providerPaymentId: string | null;
  amount: number;
  currency: string;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
  /** Algunas pasarelas confirman al instante; otras avisan después por webhook. */
  status: 'SUCCEEDED' | 'PENDING';
}

export interface ProviderRefundState {
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'NOT_FOUND';
}

/** Evento verificado y normalizado de un webhook (IPN en Izipay). */
export interface PaymentWebhookEvent {
  /** Único por proveedor: base de la idempotencia (`payment_events`). */
  providerEventId: string;
  kind: 'PAYMENT' | 'REFUND';
  /** ID del pago en Charles (la referencia que se envió al crearlo). */
  paymentId: string;
  /** Solo en reembolsos: ID del reembolso en Charles. */
  refundId: string | null;
  outcome: 'SUCCEEDED' | 'REJECTED' | 'CANCELLED' | 'FAILED';
  amount: number;
  currency: string;
  mode: ProviderMode;
  providerTransactionId: string | null;
  /** Marca de tiempo del aviso, si el proveedor la envía (Izipay no la documenta). */
  occurredAt: Date | null;
  /** Datos del aviso para `payment_events.payload` (nunca datos de tarjeta). */
  payload: Record<string, unknown>;
}

export interface RawWebhook {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface PaymentGateway {
  /** Valor de `payments.provider` (texto libre: FAKE, IZIPAY…). */
  readonly provider: string;
  /**
   * Antigüedad máxima de un webhook, en segundos, o null si el proveedor no envía marca de
   * tiempo (Izipay): entonces la protección contra repeticiones es solo la idempotencia por evento.
   */
  readonly webhookMaxAgeSeconds: number | null;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  getPayment(input: {
    paymentId: string;
    providerPaymentId: string | null;
  }): Promise<ProviderPaymentState>;
  refund(input: RefundInput): Promise<RefundResult>;
  getRefund(input: {
    refundId: string;
    providerRefundId: string | null;
  }): Promise<ProviderRefundState>;
  /** Verifica la firma y normaliza. Lanza `InvalidSignatureError` si no es auténtico. */
  parseWebhook(raw: RawWebhook): PaymentWebhookEvent;
  /**
   * Verifica la respuesta que la app reenvía tras pagar (Izipay: firmada con la clave HMAC) y
   * devuelve el ID del pago. Nunca confirma por sí sola: solo dispara la consulta al proveedor.
   */
  verifyClientResult(raw: RawWebhook): { paymentId: string };
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Resultado de un pago tal como lo aplica Charles. */
export type PaymentOutcome = 'SUCCEEDED' | 'REJECTED' | 'CANCELLED';
