import { createHmac } from 'node:crypto';
import { type AppConfig, PaymentsGateway } from '../../common/config/env.validation';
import {
  addMonths,
  BillingGatewayError,
  billingReference,
  InvalidBillingSignatureError,
  parseBillingReference,
} from './billing-gateway';
import { FAKE_BILLING_SIGNATURE_HEADER, FakeBillingGateway } from './fake-billing-gateway';
import { MercadoPagoBillingGateway } from './mercadopago-billing-gateway';

/** Cuerpo JSON enviado en una llamada a `fetch` simulada. */
function sentBody(init: unknown): Record<string, unknown> {
  return JSON.parse((init as { body: string }).body) as Record<string, unknown>;
}

const SECRET = 'secreto-webhook';
const ID = '01990000-0000-7000-8000-000000000001';

function gateway(publicApiUrl: string | null = 'https://api.charles.test') {
  const config = {
    payments: {
      gateway: PaymentsGateway.MercadoPago,
      publicApiUrl,
      mercadoPago: { accessToken: 'APP_USR-x', webhookSecret: SECRET, apiUrl: 'https://mp.test' },
    },
  } as unknown as AppConfig;
  return new MercadoPagoBillingGateway(config);
}

function mockFetch(...responses: (object | Error | { status: number; json: object })[]) {
  const spy = jest.spyOn(globalThis, 'fetch');
  for (const r of responses) {
    if (r instanceof Error) spy.mockRejectedValueOnce(r);
    else if ('status' in r && 'json' in r)
      spy.mockResolvedValueOnce(Response.json(r.json, { status: r.status }));
    else spy.mockResolvedValueOnce(Response.json(r));
  }
  return spy;
}

const signed = (dataId: string, body: object) => {
  const ts = '1704908010';
  const v1 = createHmac('sha256', SECRET)
    .update(`id:${dataId};request-id:r1;ts:${ts};`)
    .digest('hex');
  return {
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'r1' },
  };
};

describe('Facturación: referencias y fechas', () => {
  it('referencias sub/mem/spk', () => {
    expect(billingReference('sub', ID)).toBe(`sub:${ID}`);
    expect(parseBillingReference(`mem:${ID}`)).toEqual({ kind: 'mem', id: ID });
    expect(parseBillingReference(ID)).toBeNull();
    expect(parseBillingReference('xyz:1')).toBeNull();
    expect(parseBillingReference(null)).toBeNull();
  });

  it('suma meses ajustando fin de mes', () => {
    expect(addMonths(new Date('2030-01-31T12:00:00Z'), 1).toISOString()).toBe(
      '2030-02-28T12:00:00.000Z',
    );
    expect(addMonths(new Date('2030-03-15T00:00:00Z'), 12).toISOString()).toBe(
      '2031-03-15T00:00:00.000Z',
    );
  });
});

describe('Pasarela de facturación simulada', () => {
  it('suscripción idempotente por referencia, cambio de precio y firma de avisos', async () => {
    const fake = new FakeBillingGateway();
    const a = await fake.createSubscription({
      reference: `sub:${ID}`,
      reason: 'r',
      amount: 100,
      currency: 'PEN',
      frequencyMonths: 1,
      trialDays: 0,
      payerEmail: 'a@b.c',
      backUrl: 'x',
      idempotencyKey: 'k',
    });
    const b = await fake.createSubscription({
      reference: `sub:${ID}`,
      reason: 'r',
      amount: 100,
      currency: 'PEN',
      frequencyMonths: 1,
      trialDays: 0,
      payerEmail: 'a@b.c',
      backUrl: 'x',
      idempotencyKey: 'k',
    });
    expect(b.providerSubscriptionId).toBe(a.providerSubscriptionId);
    await fake.updateSubscriptionAmount(a.providerSubscriptionId, 200);
    expect(fake.amountOf(a.providerSubscriptionId)).toBe(200);
    await fake.cancelSubscription(a.providerSubscriptionId);
    expect((await fake.getSubscription(a.providerSubscriptionId)).status).toBe('CANCELLED');
    expect((await fake.getSubscription('nope')).status).toBe('NOT_FOUND');
    const checkout = await fake.createCheckout({
      reference: `spk:${ID}`,
      title: 't',
      amount: 1,
      currency: 'PEN',
      backUrl: 'x',
      idempotencyKey: 'k',
    });
    expect(checkout.checkoutUrl).toContain('fake.billing');

    const { body, signature } = fake.signedWebhook({
      kind: 'SUBSCRIPTION',
      providerEventId: 'e',
      providerSubscriptionId: a.providerSubscriptionId,
      reference: null,
      status: 'AUTHORIZED',
    });
    const event = await fake.parseWebhook({
      rawBody: Buffer.from(body),
      headers: { [FAKE_BILLING_SIGNATURE_HEADER]: signature },
    });
    expect(event.kind).toBe('SUBSCRIPTION');
    await expect(
      fake.parseWebhook({ rawBody: Buffer.from(body), headers: {} }),
    ).rejects.toBeInstanceOf(InvalidBillingSignatureError);
    fake.unavailable = true;
    await expect(fake.getSubscription('x')).rejects.toBeInstanceOf(BillingGatewayError);
  });
});

describe('Mercado Pago (facturación)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('crea la suscripción con prueba gratis y aviso firmado', async () => {
    const spy = mockFetch({ id: 'pre-1', init_point: 'https://mp/checkout' });
    const res = await gateway().createSubscription({
      reference: `sub:${ID}`,
      reason: 'Plan Pro',
      amount: 5900,
      currency: 'PEN',
      frequencyMonths: 1,
      trialDays: 14,
      payerEmail: 'a@b.c',
      backUrl: 'https://x',
      idempotencyKey: 'k1',
    });
    expect(res).toEqual({ providerSubscriptionId: 'pre-1', checkoutUrl: 'https://mp/checkout' });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://mp.test/preapproval');
    const sent = sentBody(init);
    expect(sent).toMatchObject({
      external_reference: `sub:${ID}`,
      status: 'pending',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: 59,
        currency_id: 'PEN',
        free_trial: { frequency: 14, frequency_type: 'days' },
      },
    });
    expect(sent.notification_url).toBe(
      'https://api.charles.test/api/v1/billing/webhooks/mercadopago?source_news=webhooks',
    );
    expect((init as RequestInit).headers).toMatchObject({ 'X-Idempotency-Key': 'k1' });
  });

  it('consulta, cancela y cambia el precio', async () => {
    const spy = mockFetch(
      {
        id: 'pre-1',
        status: 'authorized',
        external_reference: `sub:${ID}`,
        next_payment_date: '2030-02-01T00:00:00Z',
      },
      { status: 404, json: {} },
      { id: 'pre-1', status: 'cancelled' },
      { id: 'pre-1' },
    );
    const g = gateway();
    expect(await g.getSubscription('pre-1')).toEqual({
      status: 'AUTHORIZED',
      reference: `sub:${ID}`,
      nextPaymentAt: new Date('2030-02-01T00:00:00Z'),
    });
    expect((await g.getSubscription('x')).status).toBe('NOT_FOUND');
    await g.cancelSubscription('pre-1');
    await g.updateSubscriptionAmount('pre-1', 6900, 'PEN');
    expect(sentBody(spy.mock.calls[3]![1])).toEqual({
      auto_recurring: { transaction_amount: 69, currency_id: 'PEN' },
    });
  });

  it('errores: sin enlace, caída o respuesta con error', async () => {
    mockFetch({ id: 'x' }, new TypeError('red'), { status: 500, json: { error: 'x' } });
    const g = gateway();
    const input = {
      reference: `sub:${ID}`,
      reason: 'r',
      amount: 1,
      currency: 'PEN',
      frequencyMonths: 1 as const,
      trialDays: 0,
      payerEmail: 'a@b.c',
      backUrl: 'x',
      idempotencyKey: 'k',
    };
    await expect(g.createSubscription(input)).rejects.toBeInstanceOf(BillingGatewayError);
    await expect(g.getSubscription('a')).rejects.toBeInstanceOf(BillingGatewayError);
    await expect(g.getSubscription('a')).rejects.toBeInstanceOf(BillingGatewayError);
    await expect(
      gateway(null).createCheckout({
        reference: 'x',
        title: 't',
        amount: 1,
        currency: 'PEN',
        backUrl: 'x',
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(BillingGatewayError);
  });

  it('cobro único (preferencia)', async () => {
    mockFetch({ id: 'pref-1', init_point: 'https://mp/pay' });
    const res = await gateway().createCheckout({
      reference: `spk:${ID}`,
      title: 'Paquete',
      amount: 150000,
      currency: 'PEN',
      backUrl: 'https://x',
      idempotencyKey: 'k',
    });
    expect(res).toEqual({ providerCheckoutId: 'pref-1', checkoutUrl: 'https://mp/pay' });
  });

  it('avisos: firma, suscripción, cobro de suscripción, pago y temas ajenos', async () => {
    const g = gateway();
    await expect(
      g.parseWebhook({ rawBody: Buffer.from('{}'), headers: {} }),
    ).rejects.toBeInstanceOf(InvalidBillingSignatureError);

    mockFetch({ id: 'pre-1', status: 'authorized', external_reference: `sub:${ID}` });
    expect(
      await g.parseWebhook(
        signed('pre-1', { type: 'subscription_preapproval', data: { id: 'pre-1' } }),
      ),
    ).toEqual({
      kind: 'SUBSCRIPTION',
      providerEventId: 'pre:pre-1:AUTHORIZED',
      providerSubscriptionId: 'pre-1',
      reference: `sub:${ID}`,
      status: 'AUTHORIZED',
    });

    mockFetch(
      {
        id: 77,
        preapproval_id: 'pre-1',
        status: 'processed',
        transaction_amount: 59,
        currency_id: 'PEN',
        payment: { id: 900, status: 'approved' },
      },
      { id: 'pre-1', status: 'authorized', external_reference: `sub:${ID}` },
    );
    expect(
      await g.parseWebhook(
        signed('77', { type: 'subscription_authorized_payment', data: { id: 77 } }),
      ),
    ).toMatchObject({
      kind: 'SUBSCRIPTION_PAYMENT',
      providerPaymentId: '900',
      outcome: 'PAID',
      amount: 5900,
      reference: `sub:${ID}`,
    });

    mockFetch(
      {
        id: 78,
        preapproval_id: 'pre-1',
        status: 'recycling',
        transaction_amount: 59,
        payment: { id: 901, status: 'rejected', status_detail: 'cc_rejected' },
      },
      { id: 'pre-1', status: 'authorized', external_reference: `sub:${ID}` },
    );
    expect(
      await g.parseWebhook(
        signed('78', { type: 'subscription_authorized_payment', data: { id: 78 } }),
      ),
    ).toMatchObject({ outcome: 'FAILED', failureReason: 'cc_rejected' });

    mockFetch({
      id: 5,
      status: 'approved',
      transaction_amount: 1500,
      currency_id: 'PEN',
      external_reference: `spk:${ID}`,
    });
    expect(await g.parseWebhook(signed('5', { type: 'payment', data: { id: 5 } }))).toMatchObject({
      kind: 'PAYMENT',
      outcome: 'PAID',
      amount: 150000,
    });

    // Pago de una reserva (sin referencia de facturación): lo procesa el módulo de pagos.
    mockFetch({
      id: 6,
      status: 'approved',
      transaction_amount: 25,
      currency_id: 'PEN',
      external_reference: ID,
    });
    expect((await g.parseWebhook(signed('6', { type: 'payment', data: { id: 6 } }))).kind).toBe(
      'IGNORED',
    );
    expect(
      (await g.parseWebhook(signed('7', { type: 'merchant_order', data: { id: 7 } }))).kind,
    ).toBe('IGNORED');
  });
});
