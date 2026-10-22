import { planMembershipNotice, planSubscriptionNotice } from './notification-catalog';

const base = {
  subscriptionId: 's-1',
  userIds: ['owner-1', 'owner-2'],
  planName: 'Pro',
  barbershopName: 'Don Lucho',
  checkoutUrl: 'https://pago/x',
  trialEndsAt: new Date('2030-01-21T15:00:00Z'),
  graceUntil: new Date('2030-02-14T15:00:00Z'),
  currentPeriodEnd: new Date('2030-02-07T15:00:00Z'),
  nextPriceAmount: 6900,
  nextPriceFrom: new Date('2030-03-07T15:00:00Z'),
  currency: 'PEN',
  timezone: 'America/Lima',
};

describe('Avisos de planes (Fase 15)', () => {
  it.each([
    'checkout_ready',
    'activated',
    'trial_ending',
    'payment_failed',
    'recovered',
    'canceled',
    'expired',
    'price_change',
  ])('%s: a cada OWNER, obligatorio y sin montos en el push', (notice) => {
    const plans = planSubscriptionNotice(notice, base);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      type: 'PLAN_UPDATE',
      mandatory: true,
      resource: { type: 'subscription', id: 's-1' },
    });
    expect(plans[0]!.push.body).not.toMatch(/S\/|\d/);
    expect(plans[0]!.urgent).toBe(notice === 'payment_failed');
  });

  it('textos con fechas, enlace y precio; variantes sin datos', () => {
    expect(planSubscriptionNotice('checkout_ready', base)[0]!.email!.text).toContain(
      'https://pago/x',
    );
    expect(planSubscriptionNotice('activated', base)[0]!.detail.body).toContain(
      '21 de enero de 2030',
    );
    expect(
      planSubscriptionNotice('activated', { ...base, trialEndsAt: null })[0]!.detail.body,
    ).not.toContain('prueba');
    expect(
      planSubscriptionNotice('canceled', { ...base, currentPeriodEnd: null })[0]!.detail.body,
    ).toBe('Cancelaste el plan Pro de Don Lucho.');
    expect(planSubscriptionNotice('price_change', base)[0]!.detail.body).toContain('S/ 69.00');
    expect(
      planSubscriptionNotice('price_change', { ...base, nextPriceAmount: null })[0]!.detail.body,
    ).toContain('próxima renovación');
    expect(
      planSubscriptionNotice('checkout_ready', { ...base, checkoutUrl: null })[0]!.detail.body,
    ).toContain('enlace: ');
    expect(planSubscriptionNotice('otro', base)).toEqual([]);
  });
});

describe('Avisos de membresías (Fase 16)', () => {
  const ctx = {
    membershipId: 'm-1',
    userId: 'u-1',
    planName: 'Corte mensual',
    barbershopName: 'Don Lucho',
    checkoutUrl: 'https://pago/m',
    currentPeriodEnd: new Date('2030-02-07T15:00:00Z'),
    credits: 2,
    timezone: 'America/Lima',
  };

  it.each(['checkout_ready', 'credits_granted', 'payment_failed', 'canceled', 'expired'])(
    '%s',
    (notice) => {
      const [plan] = planMembershipNotice(notice, ctx);
      expect(plan).toMatchObject({
        userId: 'u-1',
        type: 'MEMBERSHIP_UPDATE',
        mandatory: true,
        resource: { type: 'membership', id: 'm-1' },
      });
    },
  );

  it('plural de créditos, fechas y avisos desconocidos', () => {
    expect(planMembershipNotice('credits_granted', ctx)[0]!.detail.body).toContain('2 créditos');
    expect(
      planMembershipNotice('credits_granted', { ...ctx, credits: 1 })[0]!.detail.body,
    ).toContain('1 crédito de');
    expect(
      planMembershipNotice('canceled', { ...ctx, currentPeriodEnd: null })[0]!.detail.body,
    ).toContain('hasta el .');
    expect(
      planMembershipNotice('checkout_ready', { ...ctx, checkoutUrl: null })[0]!.detail.body,
    ).toContain('pago: ');
    expect(planMembershipNotice('nada', ctx)).toEqual([]);
  });
});
