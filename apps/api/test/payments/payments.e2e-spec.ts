import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { DateTime } from 'luxon';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { BookingExpirationService } from '../../src/modules/bookings/booking-expiration';
import { CancellationReviewsService } from '../../src/modules/moderation/cancellation-reviews.service';
import {
  FAKE_SIGNATURE_HEADER,
  FakeGateway,
  type FakeWebhookBody,
} from '../../src/modules/payments/fake-gateway';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { ReconciliationService } from '../../src/modules/payments/reconciliation';
import {
  INVALID_WEBHOOKS_PER_IP,
  WEBHOOK_RATE_LIMIT,
  WEBHOOK_RATE_LIMIT_DEFAULT,
  WebhookRateLimitRefresher,
} from '../../src/modules/payments/webhook-rate-limit';
import { AuthClient, codeFrom, createAuthTestApp, waitForMail } from '../support/auth';
import { ownerWithShop } from '../support/barbershops';
import { describeError } from '../support/db';

const API = '/api/v1';
const SHOPS = `${API}/barbershops`;
const LIMA = 'America/Lima';
const MONDAY = '2030-01-07';
const lima = (date: string, hhmm: string) =>
  DateTime.fromISO(`${date}T${hhmm}`, { zone: LIMA }).toMillis();
const at = (hhmm: string, date = MONDAY) => new Date(lima(date, hhmm)).toISOString();
const MINUTE = 60_000;

interface Shop {
  owner: { client: AuthClient; token: string; userId: string; shopId: string };
  serviceId: string;
  barberId: string;
}
interface Client {
  client: AuthClient;
  token: string;
  userId: string;
}

describe('RF-PAG-001…004 Pagos, webhooks, reembolsos, conciliación y sanciones — Fase 8A (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let fake: FakeGateway;
  const clock = {
    current: lima(MONDAY, '06:00'),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    fake = app.get(FakeGateway);
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '06:00');
    fake.setUnavailable(false);
    fake.failNextCalls(0);
    fake.refundMode = 'ASYNC';
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => app.close());

  async function shopReady(): Promise<Shop> {
    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    const service = await client
      .post(
        `${SHOPS}/${owner.shopId}/services`,
        { name: 'Corte', priceAmount: 2525, durationMinutes: 30, categoryKey: 'haircut' },
        owner.token,
      )
      .expect(201);
    const barber = await client
      .post(
        `${SHOPS}/${owner.shopId}/barbers`,
        { displayName: 'Carlos', serviceIds: [service.body.id] },
        owner.token,
      )
      .expect(201);
    await client
      .put(
        `${SHOPS}/${owner.shopId}/business-hours`,
        { days: [{ dayOfWeek: 1, windows: [{ start: '09:00', end: '13:00' }] }] },
        owner.token,
      )
      .expect(200);
    return { owner: { ...owner, client }, serviceId: service.body.id, barberId: barber.body.id };
  }

  async function verifiedClient(): Promise<Client> {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    const code = codeFrom(await waitForMail(app, email, 'welcome-verification'));
    await client
      .post(`${API}/auth/email-verification/confirm`, { code }, tokens.accessToken)
      .expect(204);
    return { client, token: tokens.accessToken, userId: tokens.user.id };
  }

  async function book(who: Client, shop: Shop, hhmm = '12:00') {
    const res = await who.client
      .post(
        `${API}/bookings`,
        {
          barbershopId: shop.owner.shopId,
          serviceId: shop.serviceId,
          startAt: at(hhmm),
          barberId: shop.barberId,
        },
        who.token,
      )
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return res.body as { id: string; payment: { paymentId: string } };
  }

  /** Cada aviso sale de una IP distinta (como un proveedor con varias direcciones). */
  const sendWebhook = (webhook: { rawBody: string; signature: string }, provider = 'fake') => {
    const sender = new AuthClient(app);
    return sender.http
      .post(`${API}/payments/webhooks/${provider}`)
      .set('X-Forwarded-For', sender.ip)
      .set('Content-Type', 'application/json')
      .set(FAKE_SIGNATURE_HEADER, webhook.signature)
      .send(webhook.rawBody);
  };

  const paid = async (who: Client, shop: Shop, hhmm = '12:00') => {
    const booking = await book(who, shop, hhmm);
    await sendWebhook(fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED')).expect(200);
    return booking;
  };

  const statusOf = async (bookingId: string) =>
    (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status;
  const historyOf = async (bookingId: string) =>
    (
      await prisma.bookingStatusHistory.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((h) => h.toStatus);
  const relayAll = async () => {
    // Entrega todo lo pendiente del outbox (incluidos reintentos con espera vencida).
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { availableAt: new Date(0) },
    });
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
  };

  describe('webhooks firmados', () => {
    it('RF-PAG-002 confirma la reserva con un webhook válido y deja el evento registrado', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      const res = await sendWebhook(fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, duplicate: false });
      expect(await statusOf(booking.id)).toBe('CONFIRMED');
      const events = await prisma.paymentEvent.findMany({
        where: { paymentId: booking.payment.paymentId },
      });
      expect(events.map((e) => [e.provider, e.type])).toEqual([['FAKE', 'payment.succeeded']]);
      expect(events[0]!.payload).not.toHaveProperty('card');
    });

    it('firma inválida o alterada: 401 y sin efectos', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      const webhook = fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED');
      const tampered = webhook.rawBody.replace('"SUCCEEDED"', '"SUCCEEDED" ');
      const bad = await sendWebhook({ rawBody: tampered, signature: webhook.signature }).expect(
        401,
      );
      expect(bad.body.code).toBe('INVALID_SIGNATURE');
      await sendWebhook({ rawBody: webhook.rawBody, signature: '00'.repeat(32) }).expect(401);
      await new AuthClient(app).http
        .post(`${API}/payments/webhooks/fake`)
        .set('Content-Type', 'application/json')
        .send(webhook.rawBody)
        .expect(401);
      expect(await statusOf(booking.id)).toBe('PENDING_PAYMENT');
      expect(
        await prisma.paymentEvent.count({ where: { paymentId: booking.payment.paymentId } }),
      ).toBe(0);
    });

    it('proveedor desconocido: 404', async () => {
      await sendWebhook({ rawBody: '{}', signature: 'x' }, 'otro').expect(404);
    });

    it('evento repetido: 200 sin volver a aplicarse (idempotencia por evento)', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      const webhook = fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED');
      await sendWebhook(webhook).expect(200);
      const again = await sendWebhook(webhook).expect(200);
      expect(again.body).toEqual({ received: true, duplicate: true });
      expect(await historyOf(booking.id)).toEqual(['PENDING_PAYMENT', 'CONFIRMED']);
    });

    it('dos copias del mismo evento a la vez: se aplica una sola vez', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      const webhook = fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED');
      const results = await Promise.all([sendWebhook(webhook), sendWebhook(webhook)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results.map((r) => r.body.duplicate).sort()).toEqual([false, true]);
      expect(await historyOf(booking.id)).toEqual(['PENDING_PAYMENT', 'CONFIRMED']);
    });

    it('E: con marca de tiempo, un aviso fuera de la ventana del proveedor se rechaza', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      const old = fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED', {
        occurredAt: new Date(clock.current - 10 * MINUTE).toISOString(),
      });
      expect((await sendWebhook(old).expect(400)).body.code).toBe('WEBHOOK_TOO_OLD');
      expect(await statusOf(booking.id)).toBe('PENDING_PAYMENT');
    });

    it('importe o moneda distintos: 409, sin efectos y auditado', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      const body: FakeWebhookBody = {
        eventId: randomUUID(),
        kind: 'PAYMENT',
        paymentId: booking.payment.paymentId,
        outcome: 'SUCCEEDED',
        amount: 1,
        currency: 'PEN',
        mode: 'TEST',
        occurredAt: new Date(clock.current).toISOString(),
      };
      expect((await sendWebhook(fake.signedWebhook(body)).expect(409)).body.code).toBe(
        'WEBHOOK_MISMATCH',
      );
      await sendWebhook(
        fake.signedWebhook({ ...body, eventId: randomUUID(), amount: 2525, currency: 'USD' }),
      ).expect(409);
      expect(await statusOf(booking.id)).toBe('PENDING_PAYMENT');
      const audits = await prisma.auditLog.findMany({
        where: { action: 'payment.webhook_rejected', entityId: booking.payment.paymentId },
      });
      expect(audits).toHaveLength(2);
    });

    it('pago rechazado por webhook: la reserva se cancela y el turno se libera', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      await sendWebhook(fake.settlePayment(booking.payment.paymentId, 'REJECTED')).expect(200);
      expect(await statusOf(booking.id)).toBe('CANCELLED');
      await book(await verifiedClient(), shop);
    });
  });

  describe('límite de webhooks (por proveedor, no por IP)', () => {
    it('el cupo es del proveedor (payments.webhook_rate_limit_per_minute), aunque cambie la IP', async () => {
      clock.current = lima(MONDAY, '07:30');
      // Aísla la prueba: los contadores viven en Redis y otras suites también envían avisos.
      const redis = app.get<Redis>(REDIS_CLIENT);
      const keys = await redis.keys('rl:webhooks:provider:*');
      if (keys.length) await redis.del(...keys);
      const refresher = app.get(WebhookRateLimitRefresher);
      await prisma.appSetting.create({
        data: { key: 'payments.webhook_rate_limit_per_minute', value: 2 },
      });
      await refresher.refresh();
      try {
        const shop = await shopReady();
        const bookings = [];
        for (const hhmm of ['09:00', '10:00', '11:00'])
          bookings.push(await book(await verifiedClient(), shop, hhmm));
        const statuses = [];
        for (const booking of bookings) {
          // Cada aviso sale de una IP distinta (new AuthClient): el límite no depende de ella.
          const res = await sendWebhook(fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED'));
          statuses.push(res.status);
        }
        expect(statuses).toEqual([200, 200, 429]);
      } finally {
        await prisma.appSetting.delete({
          where: { key: 'payments.webhook_rate_limit_per_minute' },
        });
        await refresher.refresh();
      }
      expect(WEBHOOK_RATE_LIMIT.value).toBe(WEBHOOK_RATE_LIMIT_DEFAULT);
      expect(WEBHOOK_RATE_LIMIT_DEFAULT).toBe(600);
    });

    it('las firmas inválidas bloquean solo a esa IP, sin consumir el cupo del proveedor', async () => {
      clock.current = lima(MONDAY, '07:45');
      const attacker = new AuthClient(app);
      const forged = () =>
        attacker.http
          .post(`${API}/payments/webhooks/fake`)
          .set('X-Forwarded-For', attacker.ip)
          .set('Content-Type', 'application/json')
          .set(FAKE_SIGNATURE_HEADER, 'ab')
          .send('{"eventId":"x"}');
      for (let i = 0; i < INVALID_WEBHOOKS_PER_IP; i++) await forged().expect(401);
      expect((await forged().expect(429)).body.code).toBe('TOO_MANY_REQUESTS');
      // El proveedor (otra IP, firma válida) sigue entrando.
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      await sendWebhook(fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED')).expect(200);
    });
  });

  describe('reembolsos', () => {
    it('cancelación parcial: reembolso PENDING → la pasarela lo recibe → webhook → PARTIALLY_REFUNDED', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await paid(me, shop, '09:00'); // 06:00 → 180 min: 50 %
      const cancelled = await me.client
        .post(`${API}/bookings/${booking.id}/cancel`, {}, me.token)
        .expect(200);
      expect(cancelled.body.refund).toMatchObject({
        rule: 'CLIENT_PARTIAL',
        amount: { amount: 1262 },
      });

      await relayAll();
      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: booking.payment.paymentId },
      });
      expect(refund).toMatchObject({
        amount: 1262,
        status: 'PENDING',
        reasonType: 'CLIENT_CANCELLATION',
      });
      expect(refund.requestedAt).not.toBeNull();
      expect(refund.providerRefundId).toMatch(/^fake_rf_/);

      const webhook = fake.settleRefund(
        { refundId: refund.id, paymentId: booking.payment.paymentId, amount: 1262 },
        'SUCCEEDED',
      );
      await sendWebhook(webhook).expect(200);
      await sendWebhook(webhook).expect(200); // repetido: sin efectos
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: booking.payment.paymentId },
      });
      expect(payment.status).toBe('PARTIALLY_REFUNDED');

      const view = await me.client
        .get(`${API}/bookings/${booking.id}/payment`, me.token)
        .expect(200);
      expect(view.body.items[0]).toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        amount: { amount: 2525, currency: 'PEN' },
        refunds: [
          { status: 'SUCCEEDED', reasonType: 'CLIENT_CANCELLATION', amount: { amount: 1262 } },
        ],
      });
      // Otro cliente no ve el pago.
      const other = await verifiedClient();
      await other.client.get(`${API}/bookings/${booking.id}/payment`, other.token).expect(404);
    });

    it('cancelación con 5 h o más: devolución total; si la pasarela confirma al instante, REFUNDED', async () => {
      fake.refundMode = 'IMMEDIATE';
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await paid(me, shop, '11:00'); // 06:00 → 300 min exactos: total
      const res = await me.client
        .post(`${API}/bookings/${booking.id}/cancel`, {}, me.token)
        .expect(200);
      expect(res.body.refund).toMatchObject({
        rule: 'CLIENT_FULL',
        percent: 100,
        amount: { amount: 2525 },
      });
      await relayAll();
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: booking.payment.paymentId },
        include: { refunds: true },
      });
      expect(payment.status).toBe('REFUNDED');
      expect(payment.refunds.map((r) => r.status)).toEqual(['SUCCEEDED']);
    });

    it('si la pasarela está caída, el reembolso se reintenta y se envía una sola vez', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await paid(me, shop, '12:00');
      await me.client.post(`${API}/bookings/${booking.id}/cancel`, {}, me.token).expect(200);
      fake.setUnavailable(true);
      await relayAll();
      let refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: booking.payment.paymentId },
      });
      expect(refund.requestedAt).toBeNull();
      const event = await prisma.outboxEvent.findFirstOrThrow({
        where: { type: 'refund.requested', payload: { path: ['refundId'], equals: refund.id } },
      });
      expect(event).toMatchObject({ status: 'PENDING', attempts: 1 });

      fake.setUnavailable(false);
      await relayAll();
      await relayAll();
      refund = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
      expect(refund.requestedAt).not.toBeNull();
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
        'PROCESSED',
      );
    });

    it('la base impide devolver más de lo pagado (refunds_within_payment_amount)', async () => {
      const shop = await shopReady();
      const booking = await paid(await verifiedClient(), shop);
      const payments = app.get(PaymentsService);
      await payments.requestManualRefund({
        actorId: shop.owner.userId,
        paymentId: booking.payment.paymentId,
        amount: 2000,
        reason: 'ajuste',
      });
      let error: unknown;
      try {
        await payments.requestManualRefund({
          actorId: shop.owner.userId,
          paymentId: booking.payment.paymentId,
          amount: 600,
          reason: 'excede',
        });
      } catch (caught) {
        error = caught;
      }
      // Trigger refunds_within_payment_amount (Prisma no propaga el nombre, solo el mensaje).
      expect(describeError(error)).toContain('refunds exceed payment amount');
      expect(
        await prisma.auditLog.count({
          where: { action: 'refund.manual_requested', entityId: booking.payment.paymentId },
        }),
      ).toBe(1);
    });

    it('pago huérfano (confirmado tras vencer): devolución total automática', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      clock.current += 11 * MINUTE;
      fake.setUnavailable(true); // la consulta previa al vencimiento falla: se vence igual
      await app.get(BookingExpirationService).expireDue();
      fake.setUnavailable(false);
      expect(await statusOf(booking.id)).toBe('EXPIRED');
      await sendWebhook(fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED')).expect(200);
      expect(await statusOf(booking.id)).toBe('EXPIRED');
      const refunds = await prisma.refund.findMany({
        where: { paymentId: booking.payment.paymentId },
      });
      expect(refunds.map((r) => [r.reasonType, r.amount])).toEqual([['ORPHANED_PAYMENT', 2525]]);
    });
  });

  describe('D: conciliación', () => {
    it('webhook perdido con pago confirmado: termina CONFIRMED sin intervención, y el webhook tardío no se aplica dos veces', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      const lateWebhook = fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED'); // no se envía
      const totals = await app.get(ReconciliationService).runQuick();
      expect(totals.CONFIRMED).toBeGreaterThanOrEqual(1);
      expect(await statusOf(booking.id)).toBe('CONFIRMED');
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'payment.reconciled', entityId: booking.payment.paymentId },
      });
      expect(audit.changes).toMatchObject({
        values: { status: { from: 'PENDING', to: 'SUCCEEDED' } },
      });

      await sendWebhook(lateWebhook).expect(200);
      expect(await historyOf(booking.id)).toEqual(['PENDING_PAYMENT', 'CONFIRMED']);
      expect(await prisma.refund.count({ where: { paymentId: booking.payment.paymentId } })).toBe(
        0,
      );
    });

    it('pasarela caída durante la consulta: no cambia nada', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED');
      fake.setUnavailable(true);
      const totals = await app.get(ReconciliationService).runQuick();
      expect(totals.UNAVAILABLE).toBeGreaterThanOrEqual(1);
      expect(await statusOf(booking.id)).toBe('PENDING_PAYMENT');
    });

    it('C: antes de vencer se consulta la pasarela; si estaba pagado, se confirma en lugar de vencer', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED'); // webhook perdido
      clock.current += 11 * MINUTE;
      await app.get(BookingExpirationService).expireDue();
      expect(await statusOf(booking.id)).toBe('CONFIRMED');
    });

    it('C: también al crear otra reserva sobre el mismo turno', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED');
      clock.current += 11 * MINUTE;
      const other = await verifiedClient();
      const res = await other.client
        .post(
          `${API}/bookings`,
          {
            barbershopId: shop.owner.shopId,
            serviceId: shop.serviceId,
            startAt: at('12:00'),
            barberId: shop.barberId,
          },
          other.token,
        )
        .set('Idempotency-Key', randomUUID());
      expect(res.status).toBe(409);
      expect(await statusOf(booking.id)).toBe('CONFIRMED');
    });

    it('casos ambiguos (rechazado en la pasarela, importe distinto): solo se registran', async () => {
      const shop = await shopReady();
      const rejected = await book(await verifiedClient(), shop, '09:00');
      const mismatch = await book(await verifiedClient(), shop, '10:00');
      fake.settlePayment(rejected.payment.paymentId, 'REJECTED');
      fake.settlePayment(mismatch.payment.paymentId, 'SUCCEEDED');
      // Simula que la pasarela cobró otro importe.
      const reconciliation = app.get(ReconciliationService);
      const spy = jest.spyOn(fake, 'getPayment').mockResolvedValueOnce({
        status: 'PAID',
        amount: 1,
        currency: 'PEN',
        mode: 'TEST',
        providerTransactionId: 'tx',
      });
      expect(await reconciliation.checkPayment(mismatch.payment.paymentId)).toBe('REVIEW');
      spy.mockRestore();
      expect(await reconciliation.checkPayment(rejected.payment.paymentId)).toBe('REVIEW');
      expect(await statusOf(rejected.id)).toBe('PENDING_PAYMENT');
      expect(await statusOf(mismatch.id)).toBe('PENDING_PAYMENT');
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'payment.reconciliation_review',
            entityId: { in: [rejected.payment.paymentId, mismatch.payment.paymentId] },
          },
        }),
      ).toBe(2);
    });

    it('reembolso confirmado en la pasarela con el webhook perdido: lo corrige la revisión diaria', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await paid(me, shop, '12:00');
      await me.client.post(`${API}/bookings/${booking.id}/cancel`, {}, me.token).expect(200);
      await relayAll();
      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: booking.payment.paymentId },
      });
      fake.settleRefund(
        { refundId: refund.id, paymentId: booking.payment.paymentId, amount: refund.amount },
        'SUCCEEDED',
      );
      await app.get(ReconciliationService).runDaily();
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
        'SUCCEEDED',
      );
      expect(
        await prisma.auditLog.count({
          where: { action: 'refund.reconciled', entityId: refund.id },
        }),
      ).toBe(1);
    });

    it('reembolso fallido en la pasarela: solo se registra para revisión', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await paid(me, shop, '12:00');
      await me.client.post(`${API}/bookings/${booking.id}/cancel`, {}, me.token).expect(200);
      await relayAll();
      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: booking.payment.paymentId },
      });
      fake.settleRefund(
        { refundId: refund.id, paymentId: booking.payment.paymentId, amount: refund.amount },
        'FAILED',
      );
      expect(await app.get(ReconciliationService).checkRefund(refund.id)).toBe('REVIEW');
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
        'PENDING',
      );
    });

    it('un reembolso que nunca llegó a la pasarela lo reenvía la revisión diaria', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await paid(me, shop, '12:00');
      await me.client.post(`${API}/bookings/${booking.id}/cancel`, {}, me.token).expect(200);
      // Sin pasar por el outbox: el envío nunca ocurrió.
      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: booking.payment.paymentId },
      });
      fake.setUnavailable(true);
      expect(await app.get(ReconciliationService).checkRefund(refund.id)).toBe('UNAVAILABLE');
      fake.setUnavailable(false);
      await app.get(ReconciliationService).runDaily();
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).requestedAt,
      ).not.toBeNull();
    });

    it('pago inexistente en la pasarela: no cambia nada', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      jest.spyOn(fake, 'getPayment').mockResolvedValueOnce({
        status: 'NOT_FOUND',
        amount: null,
        currency: null,
        mode: null,
        providerTransactionId: null,
      });
      expect(await app.get(ReconciliationService).checkPayment(booking.payment.paymentId)).toBe(
        'UNCHANGED',
      );
      expect(await statusOf(booking.id)).toBe('PENDING_PAYMENT');
      // Un pago ya resuelto (o inexistente en Charles) tampoco se consulta.
      expect(await app.get(ReconciliationService).checkPayment(randomUUID())).toBe('UNCHANGED');
    });

    it('la pasarela responde con error a mitad de un lote: el resto del lote sigue', async () => {
      const shop = await shopReady();
      const bookings = [];
      for (const hhmm of ['09:00', '10:00', '11:00']) {
        const booking = await book(await verifiedClient(), shop, hhmm);
        fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED');
        bookings.push(booking);
      }
      const original = FakeGateway.prototype.getPayment.bind(fake);
      const failing = bookings[1]!.payment.paymentId;
      const spy = jest
        .spyOn(fake, 'getPayment')
        .mockImplementation((input) =>
          input.paymentId === failing ? Promise.reject(new Error('caída')) : original(input),
        );
      try {
        const totals = await app.get(ReconciliationService).runQuick();
        expect(totals.UNAVAILABLE).toBeGreaterThanOrEqual(1);
        expect(totals.CONFIRMED).toBeGreaterThanOrEqual(2);
      } finally {
        spy.mockRestore();
      }
      expect(await Promise.all(bookings.map((b) => statusOf(b.id)))).toEqual([
        'CONFIRMED',
        'PENDING_PAYMENT',
        'CONFIRMED',
      ]);
      // La siguiente ejecución recoge el que falló.
      await app.get(ReconciliationService).runQuick();
      expect(await statusOf(bookings[1]!.id)).toBe('CONFIRMED');
    });

    it('dos ejecuciones simultáneas del trabajo: cada pago se corrige y se audita una sola vez', async () => {
      const shop = await shopReady();
      const booking = await book(await verifiedClient(), shop);
      fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED');
      const reconciliation = app.get(ReconciliationService);
      const [a, b] = await Promise.all([reconciliation.runQuick(), reconciliation.runQuick()]);
      expect(a.CONFIRMED + b.CONFIRMED).toBeGreaterThanOrEqual(1);
      expect(await historyOf(booking.id)).toEqual(['PENDING_PAYMENT', 'CONFIRMED']);
      expect(
        await prisma.auditLog.count({
          where: { action: 'payment.reconciled', entityId: booking.payment.paymentId },
        }),
      ).toBe(1);
    });

    it('reembolso confirmado en la pasarela y PENDING en Charles: se corrige una sola vez', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await paid(me, shop, '12:00');
      await me.client.post(`${API}/bookings/${booking.id}/cancel`, {}, me.token).expect(200);
      await relayAll();
      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: booking.payment.paymentId },
      });
      fake.settleRefund(
        { refundId: refund.id, paymentId: booking.payment.paymentId, amount: refund.amount },
        'SUCCEEDED',
      );
      const reconciliation = app.get(ReconciliationService);
      const results = await Promise.all([
        reconciliation.checkRefund(refund.id),
        reconciliation.checkRefund(refund.id),
      ]);
      expect(results.filter((r) => r === 'CONFIRMED')).toHaveLength(1);
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
        'SUCCEEDED',
      );
      expect(
        await prisma.auditLog.count({
          where: { action: 'refund.reconciled', entityId: refund.id },
        }),
      ).toBe(1);
      // Un reembolso aún pendiente en la pasarela o inexistente: sin cambios.
      expect(await reconciliation.checkRefund(randomUUID())).toBe('UNCHANGED');
    });

    it('la app reenvía el resultado firmado: dispara la consulta, nunca confirma por sí solo', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await book(me, shop);
      const notPaid = fake.signedWebhook({
        eventId: randomUUID(),
        kind: 'PAYMENT',
        paymentId: booking.payment.paymentId,
        outcome: 'SUCCEEDED',
        amount: 2525,
        currency: 'PEN',
        mode: 'TEST',
      });
      const verify = (raw: { rawBody: string; signature: string }) =>
        me.client.http
          .post(`${API}/bookings/${booking.id}/payment/verify`)
          .set('Authorization', `Bearer ${me.token}`)
          .set('Content-Type', 'application/json')
          .set(FAKE_SIGNATURE_HEADER, raw.signature)
          .send(raw.rawBody);
      // La pasarela aún no lo tiene pagado: aunque la app diga SUCCEEDED, no se confirma.
      expect((await verify(notPaid).expect(200)).body).toEqual({
        outcome: 'UNCHANGED',
        paymentStatus: 'PENDING',
      });
      expect(await statusOf(booking.id)).toBe('PENDING_PAYMENT');
      const result = fake.settlePayment(booking.payment.paymentId, 'SUCCEEDED');
      expect((await verify(result).expect(200)).body).toEqual({
        outcome: 'CONFIRMED',
        paymentStatus: 'SUCCEEDED',
      });
      expect(await statusOf(booking.id)).toBe('CONFIRMED');
      expect((await verify({ ...result, signature: 'ab' }).expect(401)).body.code).toBe(
        'INVALID_SIGNATURE',
      );
    });
  });

  describe('sanción a la barbería por cancelaciones injustificadas', () => {
    async function supportUser(): Promise<string> {
      const { tokens } = await new AuthClient(app).newUser();
      await prisma.userRole.create({ data: { userId: tokens.user.id, role: 'SUPPORT' } });
      return tokens.user.id;
    }

    async function barbershopCancels(shop: Shop, hhmm: string): Promise<string> {
      const booking = await book(await verifiedClient(), shop, hhmm);
      await shop.owner.client
        .post(`${API}/bookings/${booking.id}/cancel`, { reason: 'Imprevisto' }, shop.owner.token)
        .expect(200);
      return (
        await prisma.barbershopCancellationReview.findUniqueOrThrow({
          where: { bookingId: booking.id },
        })
      ).id;
    }

    it('3 injustificadas en 30 días: SUSPENDED; las justificadas no cuentan', async () => {
      const shop = await shopReady();
      const support = await supportUser();
      const reviews = app.get(CancellationReviewsService);
      const ids = [];
      for (const hhmm of ['09:00', '09:30', '10:00', '10:30'])
        ids.push(await barbershopCancels(shop, hhmm));
      expect(await reviews.review(support, ids[0]!, 'UNJUSTIFIED')).toMatchObject({
        suspended: false,
        unjustifiedInWindow: 1,
      });
      expect(await reviews.review(support, ids[1]!, 'JUSTIFIED')).toMatchObject({
        suspended: false,
        unjustifiedInWindow: 1,
      });
      expect(await reviews.review(support, ids[2]!, 'UNJUSTIFIED')).toMatchObject({
        suspended: false,
        unjustifiedInWindow: 2,
      });
      expect(await reviews.review(support, ids[3]!, 'UNJUSTIFIED')).toMatchObject({
        suspended: true,
        unjustifiedInWindow: 3,
      });
      expect(
        (await prisma.barbershop.findUniqueOrThrow({ where: { id: shop.owner.shopId } })).status,
      ).toBe('SUSPENDED');
      expect(
        await prisma.auditLog.count({
          where: { action: 'barbershop.suspended', entityId: shop.owner.shopId },
        }),
      ).toBe(1);
      const event = await prisma.outboxEvent.findMany({ where: { type: 'barbershop.suspended' } });
      expect(
        event.some(
          (e) => (e.payload as { barbershopId: string }).barbershopId === shop.owner.shopId,
        ),
      ).toBe(true);
    });

    it('las cancelaciones fuera de la ventana de 30 días no cuentan', async () => {
      const shop = await shopReady();
      const support = await supportUser();
      const reviews = app.get(CancellationReviewsService);
      const ids = [];
      for (const hhmm of ['09:00', '09:30', '10:00']) ids.push(await barbershopCancels(shop, hhmm));
      await prisma.barbershopCancellationReview.update({
        where: { id: ids[0]! },
        data: { cancelledAt: new Date(clock.current - 31 * 24 * 3600_000) },
      });
      for (const id of ids) await reviews.review(support, id, 'UNJUSTIFIED');
      expect(
        (await prisma.barbershop.findUniqueOrThrow({ where: { id: shop.owner.shopId } })).status,
      ).toBe('OPEN');
    });

    it('solo soporte califica, y una sola vez', async () => {
      const shop = await shopReady();
      const support = await supportUser();
      const reviews = app.get(CancellationReviewsService);
      const id = await barbershopCancels(shop, '09:00');
      await expect(reviews.review(shop.owner.userId, id, 'UNJUSTIFIED')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await reviews.review(support, id, 'JUSTIFIED');
      await expect(reviews.review(support, id, 'UNJUSTIFIED')).rejects.toMatchObject({
        code: 'ALREADY_REVIEWED',
      });
      await expect(reviews.review(support, randomUUID(), 'UNJUSTIFIED')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('inasistencia (no-show)', () => {
    it('la barbería la marca desde 15 min y hasta 24 h después del inicio; sin devolución', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await paid(me, shop, '09:00');
      const mark = (who: { client: AuthClient; token: string }) =>
        who.client.post(`${API}/bookings/${booking.id}/no-show`, {}, who.token);

      clock.current = lima(MONDAY, '09:14');
      expect((await mark(shop.owner).expect(409)).body.code).toBe('NO_SHOW_NOT_ALLOWED');
      expect((await mark(me).expect(403)).body.code).toBe('FORBIDDEN');
      await mark(await verifiedClient()).expect(404);
      clock.current = lima(MONDAY, '09:15');
      const res = await mark(shop.owner).expect(200);
      expect(res.body.status).toBe('NO_SHOW');
      expect(await prisma.refund.count({ where: { paymentId: booking.payment.paymentId } })).toBe(
        0,
      );
      expect((await mark(shop.owner).expect(409)).body.code).toBe('NO_SHOW_NOT_ALLOWED');
    });

    it('el barbero asignado también la marca; pasadas 24 h ya no', async () => {
      const shop = await shopReady();
      const booking = await paid(await verifiedClient(), shop, '09:00');
      const barber = await verifiedClient();
      await prisma.barber.update({ where: { id: shop.barberId }, data: { userId: barber.userId } });
      clock.current = lima('2030-01-08', '09:01');
      await barber.client
        .post(`${API}/bookings/${booking.id}/no-show`, {}, barber.token)
        .expect(409);
      clock.current = lima(MONDAY, '20:00');
      await barber.client
        .post(`${API}/bookings/${booking.id}/no-show`, {}, barber.token)
        .expect(200);
    });
  });
});
