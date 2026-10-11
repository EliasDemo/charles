/**
 * Comisión de Charles por reserva (Fase 8B). Configurable por ADMIN desde el panel:
 * - `fees.percent_bp`: porcentaje del servicio en puntos básicos (500 = 5 %);
 * - `fees.fixed_amount`: monto fijo en céntimos;
 * - `fees.payer`: `BARBERSHOP` (se descuenta de lo que recibe la barbería; el cliente paga solo el
 *   servicio) o `CLIENT` (se suma al precio y aparece como línea FEE).
 * Se calcula al reservar y se guarda en la reserva: cambiar los ajustes no altera reservas hechas.
 * Pura, sin base de datos.
 */
export const COMMISSION_PAYERS = ['CLIENT', 'BARBERSHOP'] as const;
export type CommissionPayer = (typeof COMMISSION_PAYERS)[number];

export interface CommissionSettings {
  percentBp: number;
  fixedAmount: number;
  payer: CommissionPayer;
}

export const COMMISSION_DEFAULTS: CommissionSettings = {
  percentBp: 0,
  fixedAmount: 0,
  payer: 'BARBERSHOP',
};

/** Tope del porcentaje (30 %) y del fijo (S/ 100), los mismos que valida el panel. */
export const COMMISSION_LIMITS = { maxPercentBp: 3000, maxFixedAmount: 10_000 } as const;

export interface CommissionBreakdown {
  /** Comisión de Charles (céntimos). */
  commissionAmount: number;
  payer: CommissionPayer;
  /** Lo que paga el cliente por la comisión (línea FEE): 0 si la asume la barbería. */
  clientFee: number;
  /** Total que paga el cliente. */
  total: number;
}

export function computeCommission(
  subtotal: number,
  settings: CommissionSettings,
): CommissionBreakdown {
  const percentBp = clamp(settings.percentBp, 0, COMMISSION_LIMITS.maxPercentBp);
  const fixed = clamp(settings.fixedAmount, 0, COMMISSION_LIMITS.maxFixedAmount);
  // Nunca más que el propio servicio (una reserva de S/ 0 no genera comisión).
  const commissionAmount = Math.min(Math.round((subtotal * percentBp) / 10_000) + fixed, subtotal);
  const clientFee = settings.payer === 'CLIENT' ? commissionAmount : 0;
  return { commissionAmount, payer: settings.payer, clientFee, total: subtotal + clientFee };
}

function clamp(value: number, min: number, max: number): number {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : min;
}
