import { COMMISSION_DEFAULTS, computeCommission } from './commission-policy';

describe('Comisión de Charles', () => {
  it('por defecto no hay comisión', () => {
    expect(computeCommission(2500, COMMISSION_DEFAULTS)).toEqual({
      commissionAmount: 0,
      payer: 'BARBERSHOP',
      clientFee: 0,
      total: 2500,
    });
  });

  it('porcentaje + fijo; la asume la barbería: el cliente paga solo el servicio', () => {
    expect(
      computeCommission(2500, { percentBp: 500, fixedAmount: 50, payer: 'BARBERSHOP' }),
    ).toEqual({ commissionAmount: 175, payer: 'BARBERSHOP', clientFee: 0, total: 2500 });
  });

  it('la paga el cliente: se suma al total', () => {
    expect(computeCommission(2500, { percentBp: 1000, fixedAmount: 0, payer: 'CLIENT' })).toEqual({
      commissionAmount: 250,
      payer: 'CLIENT',
      clientFee: 250,
      total: 2750,
    });
  });

  it('redondea al céntimo, respeta los topes y nunca supera el servicio', () => {
    expect(
      computeCommission(999, { percentBp: 333, fixedAmount: 0, payer: 'CLIENT' }).commissionAmount,
    ).toBe(33);
    expect(
      computeCommission(1000, { percentBp: 9999, fixedAmount: 0, payer: 'CLIENT' })
        .commissionAmount,
    ).toBe(300);
    expect(
      computeCommission(100, { percentBp: 0, fixedAmount: 500, payer: 'BARBERSHOP' })
        .commissionAmount,
    ).toBe(100);
    expect(computeCommission(0, { percentBp: 500, fixedAmount: 50, payer: 'CLIENT' }).total).toBe(
      0,
    );
    expect(
      computeCommission(1000, { percentBp: -5, fixedAmount: 1.5, payer: 'CLIENT' })
        .commissionAmount,
    ).toBe(0);
  });
});
