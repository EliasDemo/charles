/**
 * Pasarela de pagos (CLAUDE.md §4.2, ADR 0002): la aplicación solo conoce esta interfaz.
 * Hoy existe `FakeGateway`; Izipay se integra en la Fase 8.
 *
 * Regla: ninguna llamada a la pasarela ocurre dentro de una transacción de base de datos.
 */
export interface CreatePaymentInput {
  paymentId: string;
  amount: number;
  currency: string;
  /** Misma clave = mismo cobro en la pasarela: permite reintentar sin cobrar dos veces. */
  idempotencyKey: string;
  description: string;
}

/** Lo que la app necesita para que el cliente pague (formulario, SDK, redirección…). */
export interface ClientPaymentAction {
  type: 'FAKE' | 'REDIRECT' | 'SDK';
  data: Record<string, string>;
}

export interface CreatePaymentResult {
  providerPaymentId: string;
  clientAction: ClientPaymentAction;
}

export interface PaymentGateway {
  /** Valor de `payments.provider` (texto libre: FAKE, IZIPAY…). */
  readonly provider: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Resultado de un pago, tal como lo informará el webhook verificado (Fase 8). */
export type PaymentOutcome = 'SUCCEEDED' | 'REJECTED' | 'CANCELLED';
