import {
  normalizeRefundSettings,
  REFUND_POLICY_DEFAULTS,
  refundQuote,
  type RefundRule,
} from './refund-policy';

const START = Date.parse('2030-01-07T15:00:00Z');
const MIN = 60_000;

const quote = (minutesBefore: number, by: 'CLIENT' | 'BARBERSHOP' = 'CLIENT', paid = 2525) =>
  refundQuote({
    refundableAmount: paid,
    by,
    startAt: START,
    now: START - minutesBefore * MIN,
    settings: REFUND_POLICY_DEFAULTS,
  });

describe('Política de devolución (Fase 8A)', () => {
  it.each<[string, number, RefundRule, number, number]>([
    ['con 6 h de anticipación', 360, 'CLIENT_FULL', 100, 2525],
    ['con 300 min exactos (inclusivo)', 300, 'CLIENT_FULL', 100, 2525],
    ['con 299 min', 299, 'CLIENT_PARTIAL', 50, 1262],
    ['con 120 min exactos (inclusivo)', 120, 'CLIENT_PARTIAL', 50, 1262],
    ['con 119 min', 119, 'CLIENT_NONE', 0, 0],
    ['con 1 min', 1, 'CLIENT_NONE', 0, 0],
  ])('el cliente cancela %s', (_case, minutes, rule, percent, amount) => {
    expect(quote(minutes)).toEqual({ rule, percent, amount, refundableAmount: 2525 });
  });

  it('el 50 % se redondea hacia abajo al céntimo (S/ 25,25 → S/ 12,62)', () => {
    expect(quote(200).amount).toBe(1262);
    expect(quote(200, 'CLIENT', 2501).amount).toBe(1250);
  });

  it('la barbería cancela: devolución total siempre, aunque falte poco', () => {
    expect(quote(1, 'BARBERSHOP')).toMatchObject({ rule: 'BARBERSHOP_CANCELLATION', amount: 2525 });
  });

  it('sin nada cobrado (o ya devuelto) no hay devolución', () => {
    expect(quote(600, 'CLIENT', 0)).toEqual({
      rule: 'NO_PAYMENT',
      percent: 0,
      amount: 0,
      refundableAmount: 0,
    });
    expect(quote(600, 'BARBERSHOP', 0).amount).toBe(0);
  });

  it('usa los ajustes configurados', () => {
    const custom = refundQuote({
      refundableAmount: 1000,
      by: 'CLIENT',
      startAt: START,
      now: START - 60 * MIN,
      settings: {
        fullRefundMinMinutes: 120,
        partialRefundMinMinutes: 30,
        partialRefundPercent: 25,
      },
    });
    expect(custom).toMatchObject({ rule: 'CLIENT_PARTIAL', percent: 25, amount: 250 });
  });

  it.each([
    [{ fullRefundMinMinutes: 100, partialRefundMinMinutes: 200, partialRefundPercent: 50 }],
    [{ fullRefundMinMinutes: 300, partialRefundMinMinutes: 120, partialRefundPercent: 150 }],
    [{ fullRefundMinMinutes: null, partialRefundMinMinutes: 120, partialRefundPercent: 50 }],
    [{}],
  ])('ajustes incoherentes o ausentes → valores por defecto (%p)', (raw) => {
    expect(normalizeRefundSettings(raw as never)).toEqual(REFUND_POLICY_DEFAULTS);
  });

  it('acepta ajustes coherentes', () => {
    const settings = {
      fullRefundMinMinutes: 600,
      partialRefundMinMinutes: 0,
      partialRefundPercent: 0,
    };
    expect(normalizeRefundSettings(settings)).toEqual(settings);
  });
});
