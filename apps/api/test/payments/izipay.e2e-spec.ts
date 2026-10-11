import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { validateEnv, IzipayMode, PaymentsGateway } from '../../src/common/config/env.validation';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { ReconciliationService } from '../../src/modules/payments/reconciliation';
import { AuthClient, TEST_TERMS_VERSION } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { createTestApp } from '../support/create-test-app';
import { truncateAll } from '../support/db';
import { IzipaySimulator } from '../support/izipay-simulator';

const PUBLIC = 'https://api.charles.test';
const WEDNESDAY = '2030-01-09';

describe('Fase 8B: pagos con Izipay (simulado) — página de pago, IPN, consulta, devolución y comisión (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  const izipay = new IzipaySimulator();
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    const apiUrl = await izipay.start();
    const base = validateEnv(process.env);
    app = await createTestApp({
      clock,
      config: {
        trustProxy: ['loopback'],
        payments: {
          gateway: PaymentsGateway.Izipay,
          publicApiUrl: PUBLIC,
          izipay: {
            mode: IzipayMode.Test,
            merchantCode: izipay.merchantCode,
            apiKey: izipay.apiKey,
            hashKey: izipay.hashKey,
            publicKey: izipay.publicKey,
            ruc: izipay.ruc,
            apiUrl,
            checkoutScriptUrl: base.payments.izipay.checkoutScriptUrl,
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
    await izipay.stop();
  });

  const relayAll = async () => {
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { availableAt: new Date(0) },
    });
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
  };

  async function withSettings(values: Record<string, unknown>, run: () => Promise<void>) {
    const keys = Object.keys(values);
    await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    for (const [key, value] of Object.entries(values)) {
      await prisma.appSetting.create({ data: { key, value: value as never } });
    }
    try {
      await run();
    } finally {
      await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    }
  }

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

  const pathOf = (url: string) => url.replace(PUBLIC, '');
  const ipn = (body: object) =>
    new AuthClient(app).http
      .post(`${API}/payments/webhooks/izipay`)
      .set('Content-Type', 'application/json')
      .set('transactionId', '17370678303660')
      .send(JSON.stringify(body));
  const statusOf = async (bookingId: string) =>
    (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status;

  it('la reserva devuelve IZIPAY_WEB con un enlace firmado; la página carga el formulario', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    expect(payment).toMatchObject({
      provider: 'IZIPAY',
      providerPaymentId: expect.stringMatching(/^C[0-9A-Z]{14}$/),
    });
    expect(body.payment.clientAction).toEqual({
      type: 'IZIPAY_WEB',
      data: {
        paymentUrl: expect.stringMatching(
          new RegExp(`^${PUBLIC}/api/v1/payments/izipay/checkout/${payment.id}\\?e=\\d+&s=`),
        ),
        doneUrlPrefix: `${PUBLIC}/api/v1/payments/izipay/done`,
      },
    });

    const page = await new AuthClient(app)
      .get(pathOf(body.payment.clientAction.data.paymentUrl as string))
      .expect(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
    const csp = page.headers['content-security-policy'] as string;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toContain('https://sandbox-checkout.izipay.pe');
    expect(page.text).toContain(`<script nonce="${nonce}">`);
    expect(page.text).toContain('https://sandbox-checkout.izipay.pe/payments/v1/js/index.js');
    expect(page.text).toContain(payment.providerPaymentId!);
    expect(page.text).toContain('"amount":"25.00"');
    expect(page.text).toContain('"payMethod":"CARD,YAPE_CODE"');
    expect(page.text).toContain(`"urlIPN":"${PUBLIC}/api/v1/payments/webhooks/izipay"`);
    expect(page.text).toContain('Modo de pruebas');
    // Nunca la clave API ni la clave hash en la página.
    expect(page.text).not.toContain(izipay.apiKey);
    expect(page.text).not.toContain(izipay.hashKey);
    expect(izipay.calls).toContain('POST /security/v1/Token/Generate');

    // Enlace alterado o de otro pago: 404.
    const tampered = (body.payment.clientAction.data.paymentUrl as string).replace(
      /s=.+$/,
      's=otra',
    );
    await new AuthClient(app).get(pathOf(tampered)).expect(404);
    await new AuthClient(app)
      .get(`${API}/payments/izipay/checkout/${randomUUID()}?e=9999999999999&s=x`)
      .expect(404);

    // Vencida la reserva, la página ya no ofrece pagar.
    clock.current = lima(MONDAY, '08:15');
    const late = await new AuthClient(app)
      .get(pathOf(body.payment.clientAction.data.paymentUrl as string))
      .expect(200);
    expect(late.text).toContain('status=expired');
  });

  it('IPN firmada confirma la reserva una sola vez y guarda los datos para devolver', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    const result = izipay.signedResult({
      orderNumber: payment.providerPaymentId!,
      amount: '25.00',
      payMethod: 'YAPE_CODE',
    });

    // Firma inválida: 401 y nada cambia.
    await ipn({ ...result, signature: 'firma-falsa' }).expect(401);
    expect(await statusOf(body.id as string)).toBe('PENDING_PAYMENT');

    const ok = await ipn(result).expect(200);
    expect(ok.body).toEqual({ received: true, duplicate: false });
    expect(await statusOf(body.id as string)).toBe('CONFIRMED');
    const saved = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(saved.status).toBe('SUCCEEDED');
    expect((saved.metadata as { provider: unknown }).provider).toEqual({
      uniqueId: '1286134',
      codeAuth: 'S93925',
      referenceNumber: '7000000',
      payMethod: 'YAPE_CODE',
    });
    expect(JSON.stringify(saved.metadata)).not.toContain('497010');

    // Reenvío del mismo aviso: idempotente.
    expect((await ipn(result).expect(200)).body).toEqual({ received: true, duplicate: true });
  });

  it('un rechazo no cancela la reserva (puede reintentar); un monto distinto se rechaza', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    await ipn(
      izipay.signedResult({ orderNumber: payment.providerPaymentId!, amount: '25.00', code: '05' }),
    ).expect(200);
    expect(await statusOf(body.id as string)).toBe('PENDING_PAYMENT');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'PENDING',
    );

    await ipn(
      izipay.signedResult({ orderNumber: payment.providerPaymentId!, amount: '1.00' }),
    ).expect(409);
    await ipn(izipay.signedResult({ orderNumber: 'C00000000000000', amount: '25.00' })).expect(409);
    expect(await statusOf(body.id as string)).toBe('PENDING_PAYMENT');
  });

  it('regreso del formulario: consulta el pedido a Izipay y redirige a la página final', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    izipay.markPaid(payment.providerPaymentId!, '25.00');
    const res = await new AuthClient(app).http
      .post(`${API}/payments/izipay/return/${payment.id}?r=success`)
      .type('form')
      .send(izipay.signedResult({ orderNumber: payment.providerPaymentId!, amount: '25.00' }))
      .expect(303);
    expect(res.headers.location).toBe(
      `${PUBLIC}/api/v1/payments/izipay/done?status=success&paymentId=${payment.id}&bookingId=${body.id}`,
    );
    expect(izipay.calls).toContain('POST /orderinfo/v1/Transaction/Search');
    expect(await statusOf(body.id as string)).toBe('CONFIRMED');
    const done = await new AuthClient(app)
      .get(`${API}/payments/izipay/done?status=success`)
      .expect(200);
    expect(done.text).toContain('Pago enviado');

    // Cancelado sin datos firmados: no consulta ni cambia nada.
    const other = await book(shop, lima(MONDAY, '11:00'));
    const cancel = await new AuthClient(app).http
      .post(`${API}/payments/izipay/return/${other.payment.id}?r=cancel`)
      .type('form')
      .send({ code: 'CANCEL' })
      .expect(303);
    expect(cancel.headers.location).toContain('status=cancel');
    expect(await statusOf(other.body.id as string)).toBe('PENDING_PAYMENT');
  });

  it('la conciliación confirma un pago cuya IPN no llegó', async () => {
    const shop = await kit.shopReady();
    const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
    const reconciliation = app.get(ReconciliationService);
    expect(await reconciliation.checkPayment(payment.id)).toBe('UNCHANGED');
    izipay.markPaid(payment.providerPaymentId!, '25.00');
    expect(await reconciliation.checkPayment(payment.id)).toBe('CONFIRMED');
    expect(await statusOf(body.id as string)).toBe('CONFIRMED');
    izipay.unavailable = true;
    try {
      const another = await book(shop, lima(MONDAY, '11:00'));
      expect(await reconciliation.checkPayment(another.payment.id)).toBe('UNAVAILABLE');
    } finally {
      izipay.unavailable = false;
    }
  });

  it('devolución al cancelar: token REFUND, RUC y datos del pago; luego se consulta su estado', async () => {
    const shop = await kit.shopReady();
    const { body, payment, person } = await book(shop, lima(WEDNESDAY, '10:00'));
    await ipn(
      izipay.signedResult({ orderNumber: payment.providerPaymentId!, amount: '25.00' }),
    ).expect(200);
    await person.client.post(`${API}/bookings/${body.id}/cancel`, {}, person.token).expect(200);
    await relayAll();
    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId: payment.id } });
    expect(refund).toMatchObject({
      amount: 2500,
      status: 'PENDING',
      providerRefundId: expect.stringMatching(/^\d+$/),
    });
    const sent = izipay.refunds.at(-1)!;
    expect(sent.requestSource).toBe('REFUND');
    expect(sent.body).toMatchObject({
      merchantCode: izipay.merchantCode,
      ruc: izipay.ruc,
      idUnique: '1286134',
      order: {
        authorizationCode: 'S93925',
        referenceNumber: '7000000',
        currency: 'PEN',
        refundAmount: '25.00',
      },
    });
    expect(await app.get(ReconciliationService).checkRefund(refund.id)).toBe('CONFIRMED');
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
      'SUCCEEDED',
    );
  });

  it('comisión: la paga el cliente (línea FEE) o la barbería (solo la ve la barbería)', async () => {
    const shop = await kit.shopReady();
    await withSettings(
      { 'fees.percent_bp': 1000, 'fees.fixed_amount': 50, 'fees.payer': 'CLIENT' },
      async () => {
        const { body, payment } = await book(shop, lima(MONDAY, '10:00'));
        expect(body.price.total).toEqual({ amount: 2800, currency: 'PEN' });
        expect(body.price.feeTotal).toEqual({ amount: 300, currency: 'PEN' });
        expect(body.price.lines).toContainEqual({
          type: 'FEE',
          description: 'Comisión de Charles',
          amount: { amount: 300, currency: 'PEN' },
        });
        expect(body.commission).toBeNull();
        expect(payment.amount).toBe(2800);
        const page = await new AuthClient(app)
          .get(pathOf(body.payment.clientAction.data.paymentUrl as string))
          .expect(200);
        expect(page.text).toContain('"amount":"28.00"');
      },
    );
    await withSettings({ 'fees.percent_bp': 500, 'fees.payer': 'BARBERSHOP' }, async () => {
      const { body, payment } = await book(shop, lima(MONDAY, '11:00'));
      expect(body.price.total).toEqual({ amount: 2500, currency: 'PEN' });
      expect(payment.amount).toBe(2500);
      const staff = await shop.owner.client
        .get(`${API}/bookings/${body.id}`, shop.owner.token)
        .expect(200);
      expect(staff.body.commission).toEqual({
        amount: { amount: 125, currency: 'PEN' },
        payer: 'BARBERSHOP',
      });
    });
  });
});
