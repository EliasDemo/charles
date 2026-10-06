/** Ajustes de la política de devolución (`app_settings`, decididos en la Fase 8A). */
export interface RefundPolicySettings {
  /** Con esta anticipación o más (minutos), devolución total. Por defecto 300 (5 h). */
  fullRefundMinMinutes: number;
  /** Con esta anticipación o más (y menos que la anterior), devolución parcial. Por defecto 120. */
  partialRefundMinMinutes: number;
  /** Porcentaje de la devolución parcial. Por defecto 50. */
  partialRefundPercent: number;
}

export const REFUND_POLICY_DEFAULTS: RefundPolicySettings = {
  fullRefundMinMinutes: 300,
  partialRefundMinMinutes: 120,
  partialRefundPercent: 50,
};

export type RefundRule =
  'NO_PAYMENT' | 'BARBERSHOP_CANCELLATION' | 'CLIENT_FULL' | 'CLIENT_PARTIAL' | 'CLIENT_NONE';

export interface RefundQuote {
  rule: RefundRule;
  percent: number;
  /** Céntimos a devolver (redondeado hacia abajo al céntimo). */
  amount: number;
  /** Lo efectivamente cobrado y aún no devuelto, base del cálculo. */
  refundableAmount: number;
}

/**
 * Cuánto se devuelve al cancelar (Fase 8A). Función pura: la usan la vista previa que ve el
 * cliente y la cancelación, así ambas siempre coinciden.
 * - La barbería cancela: devolución total.
 * - El cliente cancela con `fullRefundMinMinutes` o más de anticipación: total; con
 *   `partialRefundMinMinutes` o más: parcial; con menos: nada. Límites inclusivos; la anticipación
 *   se mide desde el momento de cancelar hasta `start_at`.
 */
export function refundQuote(input: {
  refundableAmount: number;
  by: 'CLIENT' | 'BARBERSHOP';
  startAt: number;
  now: number;
  settings: RefundPolicySettings;
}): RefundQuote {
  const { refundableAmount, by, startAt, now, settings } = input;
  const quote = (rule: RefundRule, percent: number): RefundQuote => ({
    rule,
    percent,
    amount: Math.floor((refundableAmount * percent) / 100),
    refundableAmount,
  });
  if (refundableAmount <= 0) return { ...quote('NO_PAYMENT', 0), amount: 0 };
  if (by === 'BARBERSHOP') return quote('BARBERSHOP_CANCELLATION', 100);
  const notice = startAt - now;
  if (notice >= settings.fullRefundMinMinutes * 60_000) return quote('CLIENT_FULL', 100);
  if (notice >= settings.partialRefundMinMinutes * 60_000) {
    return quote('CLIENT_PARTIAL', settings.partialRefundPercent);
  }
  return quote('CLIENT_NONE', 0);
}

/** Valida los ajustes: si no son coherentes se usan los valores por defecto. */
export function normalizeRefundSettings(raw: Partial<RefundPolicySettings>): RefundPolicySettings {
  const full = raw.fullRefundMinMinutes;
  const partial = raw.partialRefundMinMinutes;
  const percent = raw.partialRefundPercent;
  const valid =
    Number.isInteger(full) &&
    Number.isInteger(partial) &&
    Number.isInteger(percent) &&
    (partial as number) >= 0 &&
    (full as number) >= (partial as number) &&
    (percent as number) >= 0 &&
    (percent as number) <= 100;
  return valid
    ? {
        fullRefundMinMinutes: full as number,
        partialRefundMinMinutes: partial as number,
        partialRefundPercent: percent as number,
      }
    : REFUND_POLICY_DEFAULTS;
}
