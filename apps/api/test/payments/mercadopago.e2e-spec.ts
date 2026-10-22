import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PaymentsGateway, validateEnv } from '../../src/common/config/env.validation';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { ReconciliationService } from '../../src/modules/payments/reconciliation';
import { AuthClient, TEST_TERMS_VERSION } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { createTestApp } from '../support/create-test-app';
import { truncateAll } from '../support/db';
import { MercadoPagoSimulator } from '../support/mercadopago-simulator';

const PUBLIC = 'https://api.charles.test';
const WEDNESDAY = '2030-01-09';

describe('Pagos con Mercado Pago (simulado) — Checkout Pro, webhook firmado, consulta y devolución (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  const mp = new MercadoPagoSimulator();
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    const apiUrl = await mp.start();
    const base = validateEnv(process.env);
    app = await createTestApp({
      clock,
      config: {
        trustProxy: ['loopback'],
        payments: {
          ...base.payments,
          gateway: PaymentsGateway.MercadoPago,
          publicApiUrl: PUBLIC,
          mercadoPago: {
            accessToken: mp.accessToken,
            webhookSecret: mp.webhookSecret,
            apiUrl,
            clientId: null,
            clientSecret: null,
          },
        },
      },
    });
    prisma = app.get(PrismaService);
    await truncateAll(prisma);
    await prisma.appSetting.create({
      data: { key: 'legal.terms_version', value: TEST_TERMS_VERSION },
    });
    kit = bookingKit(app, clock);
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
  });
  afterAll(async () => {
    await app.close();
    await mp.stop();
  });

  const relayAll = async () => {
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { availableAt: new Date(0) },
    });
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
  };

  async function book(
    shop: Awaited<ReturnType<BookingKit['shopReady']>>,
    at: number,
    who?: Person,
  ) {
    const person = who ?? (await kit.verified());
    const res = await person.client
      .post(
        `${API}/bookings`,
        {
          barbershopId: shop.shopId,
          serviceId: shop.serviceId,
          startAt: new Date(at).toISOString(),
          barberId: shop.barberId,
        },
        person.token,
      )
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: res.body.payment.paymentId as string },
    });
    return { body: res.body, person, payment };
  }

  const webhook = (
    w: ReturnType<MercadoPagoSimulator['webhook']>,
    headers: Record<string, string> = w.headers,
  ) =>
    new AuthClient(app).http
      .post(
        `${API}/payments/webhooks/mercadopago?source_news=webhooks&data.id=${w.body.data.id}&type=payment`,
      )
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(JSON.stringify(w.body));
  const statusOf = async (bookingId: string) =>
    (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status;

  it('crea la preferencia (monto, referencia, URLs, vencimiento) y devuelve MERCADOPAGO_WEB', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    expect(payment).toMatchObject({
      provider: 'MERCADOPAGO',
      providerPaymentId: expect.stringMatching(/^724484980-/),
    });
    expect(body.payment.clientAction).toEqual({
      type: 'MERCADOPAGO_WEB',
      data: {
        paymentUrl: expect.stringContaining(
          'https://www.mercadopago.com.pe/checkout/v1/redirect?pref_id=',
        ),
        doneUrlPrefix: `${PUBLIC}/api/v1/payments/done`,
      },
    });
    const pref = mp.preferences.at(-1)!;
    expect(pref).toMatchObject({
      items: [{ quantity: 1, currency_id: 'PEN', unit_price: 25 }],
      external_reference: payment.id,
      notification_url: `${PUBLIC}/api/v1/payments/webhooks/mercadopago?source_news=webhooks`,
      back_urls: {
        success: `${PUBLIC}/api/v1/payments/mercadopago/return/${payment.id}?r=success`,
        pending: `${PUBLIC}/api/v1/payments/mercadopago/return/${payment.id}?r=pending`,
        failure: `${PUBLIC}/api/v1/payments/mercadopago/return/${payment.id}?r=failure`,
      },
      auto_return: 'approved',
      expires: true,
    });
    expect(mp.idempotencyKeys).toContain(payment.idempotencyKey);
  });

  it('webhook firmado y aprobado confirma una vez; firma inválida 401; otros temas se ignoran', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    const mpId = mp.pay({ externalReference: payment.id, amount: 25 });
    const w = mp.webhook(mpId);

    await webhook(w, {
      ...w.headers,
      'x-signature': w.headers['x-signature'].replace(/v1=\w+/, 'v1=abc'),
    }).expect(401);
    await webhook(mp.webhook(mpId, 'payment', 'otro-secreto')).expect(401);
    expect(await statusOf(body.id as string)).toBe('PENDING_PAYMENT');

    expect((await webhook(w).expect(200)).body).toEqual({ received: true, duplicate: false });
    expect(await statusOf(body.id as string)).toBe('CONFIRMED');
    const saved = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect((saved.metadata as { provider: unknown }).provider).toEqual({
      mpPaymentId: mpId,
      paymentMethod: 'visa',
      paymentType: 'credit_card',
    });
    // Reenvío del mismo estado: idempotente.
    expect((await webhook(mp.webhook(mpId)).expect(200)).body).toEqual({
      received: true,
      duplicate: true,
    });
    // Otro tema (merchant_order): se recibe y no se procesa.
    expect((await webhook(mp.webhook('555', 'merchant_order')).expect(200)).body).toEqual({
      received: true,
      duplicate: false,
    });
  });

  it('pendiente (Yape) o rechazado no cambian la reserva; al aprobarse después, confirma', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    const rejected = mp.pay({ externalReference: payment.id, amount: 25, status: 'rejected' });
    await webhook(mp.webhook(rejected)).expect(200);
    const yape = mp.pay({
      externalReference: payment.id,
      amount: 25,
      status: 'pending',
      method: 'yape',
    });
    await webhook(mp.webhook(yape)).expect(200);
    expect(await statusOf(body.id as string)).toBe('PENDING_PAYMENT');
    mp.setStatus(yape, 'approved');
    await webhook(mp.webhook(yape)).expect(200);
    expect(await statusOf(body.id as string)).toBe('CONFIRMED');
  });

  it('monto distinto o pago de prueba en producción: se rechaza', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    await webhook(mp.webhook(mp.pay({ externalReference: payment.id, amount: 1 }))).expect(409);
    await webhook(mp.webhook(mp.pay({ externalReference: randomUUID(), amount: 25 }))).expect(409);
    expect(await statusOf(body.id as string)).toBe('PENDING_PAYMENT');
  });

  it('regreso de Checkout Pro: consulta el pago y lleva a la página final', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    mp.pay({ externalReference: payment.id, amount: 25 });
    const res = await new AuthClient(app).http
      .get(
        `${API}/payments/mercadopago/return/${payment.id}?r=success&payment_id=1&status=approved`,
      )
      .expect(303);
    expect(res.headers.location).toBe(
      `${PUBLIC}/api/v1/payments/done?status=success&paymentId=${payment.id}&bookingId=${body.id}`,
    );
    expect(await statusOf(body.id as string)).toBe('CONFIRMED');
    const done = await new AuthClient(app).get(`${API}/payments/done?status=pending`).expect(200);
    expect(done.text).toContain('Pago en proceso');

    const other = await book(shop, lima(MONDAY, '11:00'));
    const failed = await new AuthClient(app).http
      .get(`${API}/payments/mercadopago/return/${other.payment.id}?r=failure`)
      .expect(303);
    expect(failed.headers.location).toContain('status=error');
    expect(await statusOf(other.body.id as string)).toBe('PENDING_PAYMENT');
  });

  it('conciliación por external_reference; caída de Mercado Pago', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    const reconciliation = app.get(ReconciliationService);
    expect(await reconciliation.checkPayment(payment.id)).toBe('UNCHANGED');
    mp.pay({ externalReference: payment.id, amount: 25, status: 'rejected' });
    expect(await reconciliation.checkPayment(payment.id)).toBe('REVIEW');
    mp.pay({ externalReference: payment.id, amount: 25 });
    expect(await reconciliation.checkPayment(payment.id)).toBe('CONFIRMED');
    expect(await statusOf(body.id as string)).toBe('CONFIRMED');
    mp.unavailable = true;
    try {
      // La reserva se crea igual; sin preferencia, la app reintenta con POST /bookings/{id}/payment.
      const another = await book(shop, lima(MONDAY, '11:00'));
      expect(another.body.payment.clientAction).toBeNull();
      await another.person.client
        .post(`${API}/bookings/${another.body.id}/payment`, {}, another.person.token)
        .expect(502);
      expect(await reconciliation.checkPayment(another.payment.id)).toBe('UNAVAILABLE');
    } finally {
      mp.unavailable = false;
    }
  });

  it('devolución al cancelar (idempotente) y consulta de su estado', async () => {
    const shop = await kit.shopReady();
    const { body, payment, person } = await book(shop, lima(WEDNESDAY, '10:00'));
    const mpId = mp.pay({ externalReference: payment.id, amount: 25 });
    await webhook(mp.webhook(mpId)).expect(200);
    mp.refundStatus = 'in_process';
    await person.client.post(`${API}/bookings/${body.id}/cancel`, {}, person.token).expect(200);
    await relayAll();
    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId: payment.id } });
    expect(refund).toMatchObject({
      amount: 2500,
      status: 'PENDING',
      providerRefundId: expect.stringMatching(new RegExp(`^${mpId}:\\d+$`)),
    });
    expect(mp.idempotencyKeys).toContain(refund.idempotencyKey);
    expect(await app.get(ReconciliationService).checkRefund(refund.id)).toBe('UNCHANGED');
    mp.refundStatus = 'approved';
  });
});
