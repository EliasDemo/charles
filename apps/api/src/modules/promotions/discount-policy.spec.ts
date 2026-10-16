import {
  appliesTo,
  type BookingContext,
  chooseBest,
  discountAmount,
  MIN_PAYABLE_AMOUNT,
  parseRules,
  type PromotionCandidate,
} from './discount-policy';

const ctx: BookingContext = {
  barbershopId: 'shop-1',
  serviceId: 'svc-1',
  subtotal: 2500,
  currency: 'PEN',
  dayOfWeek: 2,
};

const promo = (overrides: Partial<PromotionCandidate>): PromotionCandidate => ({
  id: 'p',
  name: 'Promo',
  scope: 'PLATFORM',
  scopeId: null,
  type: 'PERCENTAGE',
  value: 10,
  currency: null,
  rules: {},
  ...overrides,
});

describe('discount-policy (Fase 13)', () => {
  it('porcentaje redondeado y monto fijo', () => {
    expect(discountAmount(promo({ value: 20 }), 2500)).toBe(500);
    expect(discountAmount(promo({ value: 15 }), 2499)).toBe(375);
    expect(discountAmount(promo({ type: 'FIXED_AMOUNT', value: 700 }), 2500)).toBe(700);
  });

  it('nunca deja menos que el mínimo a pagar', () => {
    expect(discountAmount(promo({ value: 100 }), 2500)).toBe(2500 - MIN_PAYABLE_AMOUNT);
    expect(discountAmount(promo({ type: 'FIXED_AMOUNT', value: 9999 }), 1000)).toBe(900);
    expect(discountAmount(promo({ value: 50 }), 80)).toBe(0);
  });

  it('alcance, moneda y días', () => {
    expect(appliesTo(promo({ scope: 'BARBERSHOP', scopeId: 'shop-1' }), ctx)).toBe(true);
    expect(appliesTo(promo({ scope: 'BARBERSHOP', scopeId: 'shop-2' }), ctx)).toBe(false);
    expect(appliesTo(promo({ scope: 'SERVICE', scopeId: 'svc-1' }), ctx)).toBe(true);
    expect(appliesTo(promo({ scope: 'SERVICE', scopeId: 'svc-2' }), ctx)).toBe(false);
    expect(appliesTo(promo({ type: 'FIXED_AMOUNT', value: 100, currency: 'USD' }), ctx)).toBe(
      false,
    );
    expect(appliesTo(promo({ rules: { daysOfWeek: [2, 4] } }), ctx)).toBe(true);
    expect(appliesTo(promo({ rules: { daysOfWeek: [5] } }), ctx)).toBe(false);
    expect(appliesTo(promo({ rules: { daysOfWeek: [] } }), ctx)).toBe(true);
  });

  it('elige el mayor; a igual monto, la de Charles', () => {
    const shop = promo({ id: 'a', scope: 'BARBERSHOP', scopeId: 'shop-1', value: 20 });
    const platform = promo({ id: 'b', value: 20 });
    const small = promo({ id: 'c', value: 5 });
    expect(chooseBest([small, shop], ctx)).toMatchObject({
      promotion: { id: 'a' },
      amount: 500,
      funder: 'BARBERSHOP',
    });
    expect(chooseBest([shop, platform], ctx)).toMatchObject({
      promotion: { id: 'b' },
      funder: 'CHARLES',
    });
    expect(chooseBest([promo({ scope: 'SERVICE', scopeId: 'otro' })], ctx)).toBeNull();
    expect(chooseBest([], ctx)).toBeNull();
  });

  it('a igual monto y quien asume, gana el id menor', () => {
    const x = promo({ id: 'b' });
    const y = promo({ id: 'a' });
    expect(chooseBest([x, y], ctx)?.promotion.id).toBe('a');
  });

  it('reglas: ignora lo que no es válido', () => {
    expect(parseRules(null)).toEqual({});
    expect(parseRules([])).toEqual({});
    expect(parseRules({ daysOfWeek: 'lunes' })).toEqual({});
    expect(parseRules({ daysOfWeek: [1, 7, -1, 2.5, 3] })).toEqual({ daysOfWeek: [1, 3] });
  });
});
