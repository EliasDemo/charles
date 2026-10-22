import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DateTime } from 'luxon';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import { Client as PgClient } from 'pg';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { Prisma } from '../../src/generated/prisma/client';
import { LOCK_TIMEOUT_MS } from '../../src/modules/bookings/bookings.service';
import { BookingExpirationService } from '../../src/modules/bookings/booking-expiration';
import {
  BOOKING_RATE_LIMIT,
  BOOKING_RATE_LIMIT_DEFAULT,
  BookingRateLimitRefresher,
} from '../../src/modules/bookings/booking-rate-limit';
import { FAKE_SIGNATURE_HEADER, FakeGateway } from '../../src/modules/payments/fake-gateway';
import { AuthClient, codeFrom, createAuthTestApp, waitForMail } from '../support/auth';
import { ownerWithShop } from '../support/barbershops';
import { expectConstraintViolation } from '../support/db';

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
  barberIds: string[];
}

interface Client {
  client: AuthClient;
  token: string;
  userId: string;
}

describe('RF-RES-001…008 Reservas, máquina de estados, outbox y expiración (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
  });
  afterAll(() => app.close());

  /** Barbería con horario lunes 09:00–13:00, servicio de 30 min (S/ 25) y `barbers` barberos. */
  async function shopReady(barbers = 1): Promise<Shop> {
    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    const service = await client
      .post(
        `${SHOPS}/${owner.shopId}/services`,
        { name: 'Corte', priceAmount: 2500, durationMinutes: 30, categoryKey: 'haircut' },
        owner.token,
      )
      .expect(201);
    const barberIds: string[] = [];
    for (let i = 0; i < barbers; i++) {
      const barber = await client
        .post(
          `${SHOPS}/${owner.shopId}/barbers`,
          { displayName: `Barbero ${i + 1}`, serviceIds: [service.body.id] },
          owner.token,
        )
        .expect(201);
      barberIds.push(barber.body.id);
    }
    await client
      .put(
        `${SHOPS}/${owner.shopId}/business-hours`,
        { days: [{ dayOfWeek: 1, windows: [{ start: '09:00', end: '13:00' }] }] },
        owner.token,
      )
      .expect(200);
    return { owner: { ...owner, client }, serviceId: service.body.id, barberIds };
  }

  /** Cliente con el correo verificado (por el flujo real del código). */
  async function verifiedClient(): Promise<Client> {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    const code = codeFrom(await waitForMail(app, email, 'welcome-verification'));
    await client
      .post(`${API}/auth/email-verification/confirm`, { code }, tokens.accessToken)
      .expect(204);
    return { client, token: tokens.accessToken, userId: tokens.user.id };
  }

  function book(
    who: Client,
    shop: Shop,
    startAt: string,
    options: { barberId?: string | null; key?: string } = {},
  ) {
    const barberId = options.barberId === undefined ? shop.barberIds[0] : options.barberId;
    return who.client
      .post(
        `${API}/bookings`,
        {
          barbershopId: shop.owner.shopId,
          serviceId: shop.serviceId,
          startAt,
          ...(barberId ? { barberId } : {}),
        },
        who.token,
      )
      .set('Idempotency-Key', options.key ?? randomUUID());
  }

  /** Simula que el cliente pagó (o fue rechazado) y llega el webhook firmado de la pasarela. */
  const pay = (paymentId: string, outcome: 'SUCCEEDED' | 'REJECTED') => {
    const { rawBody, signature } = app.get(FakeGateway).settlePayment(paymentId, outcome);
    return new AuthClient(app).http
      .post(`${API}/payments/webhooks/fake`)
      .set('Content-Type', 'application/json')
      .set(FAKE_SIGNATURE_HEADER, signature)
      .send(rawBody);
  };

  const history = (bookingId: string) =>
    prisma.bookingStatusHistory.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
  const eventsOf = async (bookingId: string) =>
    (await prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } }))
      .filter((e) => (e.payload as { bookingId?: string }).bookingId === bookingId)
      .map((e) => e.type);

  describe('RF-RES-002 crear reserva', () => {
    it('RF-RES-002 queda PENDING_PAYMENT con copia del servicio, desglose, plazo, pago y evento', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const res = await book(me, shop, at('10:00')).expect(201);
      expect(res.body).toMatchObject({
        status: 'PENDING_PAYMENT',
        barbershop: { id: shop.owner.shopId },
        service: { id: shop.serviceId, name: 'Corte' },
        barber: { id: shop.barberIds[0], name: 'Barbero 1' },
        barberChosenByClient: true,
        client: null,
        startAt: at('10:00'),
        endAt: at('10:30'),
        durationMinutes: 30,
        price: {
          subtotal: { amount: 2500, currency: 'PEN' },
          total: { amount: 2500, currency: 'PEN' },
          lines: [
            { type: 'SERVICE', description: 'Corte', amount: { amount: 2500, currency: 'PEN' } },
            // Comisión de Charles preparada en 0 (sin definir).
            {
              type: 'FEE',
              description: 'Comisión de Charles',
              amount: { amount: 0, currency: 'PEN' },
            },
          ],
        },
        expiresAt: new Date(clock.current + 10 * MINUTE).toISOString(),
        cancellation: null,
        payment: { provider: 'FAKE', status: 'PENDING', clientAction: { type: 'FAKE' } },
      });
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: res.body.payment.paymentId },
      });
      expect(payment.providerPaymentId).toMatch(/^fake_/);
      expect((await history(res.body.id)).map((h) => [h.fromStatus, h.toStatus])).toEqual([
        [null, 'PENDING_PAYMENT'],
      ]);
      expect(await eventsOf(res.body.id)).toEqual(['booking.created']);
    });

    it('RF-SER-002 cambiar el precio del servicio no altera una reserva ya hecha', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const res = await book(me, shop, at('10:00')).expect(201);
      await shop.owner.client
        .patch(
          `${SHOPS}/${shop.owner.shopId}/services/${shop.serviceId}`,
          { priceAmount: 9900, name: 'Corte premium' },
          shop.owner.token,
        )
        .expect(200);
      const again = await me.client.get(`${API}/bookings/${res.body.id}`, me.token).expect(200);
      expect(again.body.price.total.amount).toBe(2500);
      expect(again.body.service.name).toBe('Corte');
    });

    it('requiere correo verificado (403 EMAIL_NOT_VERIFIED)', async () => {
      const shop = await shopReady();
      const client = new AuthClient(app);
      const { tokens } = await client.newUser();
      const res = await book(
        { client, token: tokens.accessToken, userId: tokens.user.id },
        shop,
        at('10:00'),
      ).expect(403);
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('Idempotency-Key: la misma petición devuelve la misma reserva; otra distinta es 409', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const key = randomUUID();
      const first = await book(me, shop, at('10:00'), { key }).expect(201);
      const second = await book(me, shop, at('10:00'), { key }).expect(200);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.payment.paymentId).toBe(first.body.payment.paymentId);
      const reused = await book(me, shop, at('11:00'), { key }).expect(409);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await prisma.booking.count({ where: { clientId: me.userId } })).toBe(1);
    });

    it('Idempotency-Key ausente o inválida: 400', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const body = {
        barbershopId: shop.owner.shopId,
        serviceId: shop.serviceId,
        startAt: at('10:00'),
      };
      const missing = await me.client.post(`${API}/bookings`, body, me.token).expect(400);
      expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      await me.client
        .post(`${API}/bookings`, body, me.token)
        .set('Idempotency-Key', 'abc')
        .expect(400);
    });

    it.each([
      ['fuera de la cuadrícula de turnos', () => at('10:05')],
      ['en el pasado', () => at('07:30')],
      ['fuera del horario', () => at('14:00')],
      ['más allá del horizonte', () => at('10:00', '2030-03-04')],
    ])('E: un inicio %s responde 409 SLOT_NOT_AVAILABLE', async (_case, startAt) => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const res = await book(me, shop, startAt()).expect(409);
      expect(res.body.code).toBe('SLOT_NOT_AVAILABLE');
    });

    it('E: respeta la anticipación mínima configurada', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      clock.current = lima(MONDAY, '09:30');
      await prisma.appSetting.create({
        data: { key: 'availability.min_lead_time_minutes', value: 60 },
      });
      try {
        expect((await book(me, shop, at('10:00')).expect(409)).body.code).toBe(
          'SLOT_NOT_AVAILABLE',
        );
        await book(me, shop, at('10:30')).expect(201);
      } finally {
        await prisma.appSetting.delete({ where: { key: 'availability.min_lead_time_minutes' } });
      }
    });

    it('una barbería cerrada temporalmente no acepta reservas; una inexistente es 404', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      await shop.owner.client
        .patch(
          `${SHOPS}/${shop.owner.shopId}/status`,
          { status: 'TEMPORARILY_CLOSED' },
          shop.owner.token,
        )
        .expect(200);
      expect((await book(me, shop, at('10:00')).expect(409)).body.code).toBe('SLOT_NOT_AVAILABLE');
      await me.client
        .post(
          `${API}/bookings`,
          { barbershopId: randomUUID(), serviceId: shop.serviceId, startAt: at('10:00') },
          me.token,
        )
        .set('Idempotency-Key', randomUUID())
        .expect(404);
    });

    it('si el outbox falla, no queda nada: ni reserva, ni historial, ni pago', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const spy = jest
        .spyOn(app.get(OutboxService), 'publish')
        .mockRejectedValueOnce(new Error('fallo simulado'));
      try {
        await book(me, shop, at('10:00')).expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.booking.count({ where: { clientId: me.userId } })).toBe(0);
      expect(await prisma.payment.count({ where: { booking: { clientId: me.userId } } })).toBe(0);
      await book(me, shop, at('10:00')).expect(201);
    });
  });

  describe('protección contra abuso', () => {
    it('máximo 2 reservas PENDING_PAYMENT vigentes por cliente; al vencer se libera el cupo', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      await book(me, shop, at('09:00')).expect(201);
      await book(me, shop, at('09:30')).expect(201);
      const third = await book(me, shop, at('10:00')).expect(409);
      expect(third.body).toMatchObject({
        code: 'TOO_MANY_PENDING_BOOKINGS',
        details: [{ maxPending: 2 }],
      });
      clock.current += 11 * MINUTE;
      await book(me, shop, at('10:00')).expect(201);
    });

    it('el límite es configurable (booking.max_pending_per_client)', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      await prisma.appSetting.create({ data: { key: 'booking.max_pending_per_client', value: 1 } });
      try {
        await book(me, shop, at('09:00')).expect(201);
        await book(me, shop, at('09:30')).expect(409);
      } finally {
        await prisma.appSetting.delete({ where: { key: 'booking.max_pending_per_client' } });
      }
    });

    it('un mismo cliente puede tener reservas que se solapan (acompañante)', async () => {
      const shop = await shopReady(2);
      const me = await verifiedClient();
      await book(me, shop, at('10:00'), { barberId: shop.barberIds[0] }).expect(201);
      await book(me, shop, at('10:00'), { barberId: shop.barberIds[1] }).expect(201);
    });

    it('límite de peticiones por cliente para crear reservas (configurable)', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const refresher = app.get(BookingRateLimitRefresher);
      await prisma.appSetting.create({ data: { key: 'booking.rate_limit_per_minute', value: 2 } });
      await refresher.refresh();
      try {
        await book(me, shop, at('09:00')).expect(201);
        await book(me, shop, at('09:30')).expect(201);
        const blocked = await book(me, shop, at('10:00')).expect(429);
        expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');
        // Otro cliente no está limitado.
        await book(await verifiedClient(), shop, at('10:00')).expect(201);
      } finally {
        await prisma.appSetting.delete({ where: { key: 'booking.rate_limit_per_minute' } });
        await refresher.refresh();
      }
      expect(BOOKING_RATE_LIMIT.value).toBe(BOOKING_RATE_LIMIT_DEFAULT);
    });
  });

  describe('"cualquier barbero"', () => {
    it('asigna al libre con menos reservas activas ese día', async () => {
      const shop = await shopReady(2);
      const [first, second] = [...shop.barberIds].sort();
      // El de menor ID ya tiene una reserva ese día: se asigna al otro.
      await book(await verifiedClient(), shop, at('12:00'), { barberId: first }).expect(201);
      const res = await book(await verifiedClient(), shop, at('10:00'), { barberId: null }).expect(
        201,
      );
      expect(res.body.barber.id).toBe(second);
      expect(res.body.barberChosenByClient).toBe(false);
    });

    it('a igualdad de carga, por ID; un barbero ocupado en ese turno se salta', async () => {
      const shop = await shopReady(2);
      const [first, second] = [...shop.barberIds].sort();
      const a = await book(await verifiedClient(), shop, at('10:00'), { barberId: null }).expect(
        201,
      );
      expect(a.body.barber.id).toBe(first);
      const b = await book(await verifiedClient(), shop, at('10:00'), { barberId: null }).expect(
        201,
      );
      expect(b.body.barber.id).toBe(second);
      const c = await book(await verifiedClient(), shop, at('10:00'), { barberId: null }).expect(
        409,
      );
      expect(c.body.code).toBe('SLOT_NOT_AVAILABLE');
    });
  });

  describe('RF-RES-007 concurrencia por API', () => {
    it('RF-RES-007 dos clientes, mismo barbero y turno, a la vez: exactamente uno tiene éxito (10 rondas)', async () => {
      // 10 turnos que no se solapan entre sí (8 en una barbería y 2 en otra).
      const shops = [await shopReady(), await shopReady()];
      const day = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'];
      const rounds = [
        ...day.map((hhmm) => ({ shop: shops[0]!, hhmm })),
        ...day.slice(0, 2).map((hhmm) => ({ shop: shops[1]!, hhmm })),
      ];
      const results: number[][] = [];
      for (const { shop, hhmm } of rounds) {
        const [a, b] = await Promise.all([verifiedClient(), verifiedClient()]);
        const responses = await Promise.all([book(a, shop, at(hhmm)), book(b, shop, at(hhmm))]);
        const statuses = responses.map((r) => r.status).sort();
        results.push(statuses);
        // Si falla, muestra qué respondió cada petición (para diagnosticar, no solo el estado).
        if (statuses[0] !== 201 || statuses[1] !== 409) {
          throw new Error(
            `Ronda ${hhmm}: ${JSON.stringify(responses.map((r) => ({ status: r.status, body: r.body })))}`,
          );
        }
        expect(statuses).toEqual([201, 409]);
        expect(responses.find((r) => r.status === 409)!.body.code).toBe('SLOT_NOT_AVAILABLE');
        const active = await prisma.booking.count({
          where: {
            barbershopId: shop.owner.shopId,
            startAt: new Date(at(hhmm)),
            status: 'PENDING_PAYMENT',
          },
        });
        expect(active).toBe(1);
      }
      expect(results).toEqual(Array.from({ length: 10 }, () => [201, 409]));
    }, 120_000);

    it('RF-RES-007 "cualquier barbero" con dos barberos: ambas tienen éxito, con barberos distintos', async () => {
      const shop = await shopReady(2);
      const [a, b] = await Promise.all([verifiedClient(), verifiedClient()]);
      const responses = await Promise.all([
        book(a, shop, at('10:00'), { barberId: null }),
        book(b, shop, at('10:00'), { barberId: null }),
      ]);
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      expect(new Set(responses.map((r) => r.body.barber.id)).size).toBe(2);
    });

    it('RF-RES-007 "cualquier barbero" con un barbero: solo una', async () => {
      const shop = await shopReady(1);
      const [a, b] = await Promise.all([verifiedClient(), verifiedClient()]);
      const responses = await Promise.all([
        book(a, shop, at('10:00'), { barberId: null }),
        book(b, shop, at('10:00'), { barberId: null }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    });

    it('el mismo cliente y la misma clave, a la vez: una sola reserva', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const key = randomUUID();
      const responses = await Promise.all([
        book(me, shop, at('10:00'), { key }),
        book(me, shop, at('10:00'), { key }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
      expect(responses[0].body.id).toBe(responses[1].body.id);
      expect(await prisma.booking.count({ where: { clientId: me.userId } })).toBe(1);
    });
  });

  describe('contención de la base en POST /bookings (nunca 500)', () => {
    const dbError = (pgCode: string) =>
      new Prisma.PrismaClientKnownRequestError('contención simulada', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { driverAdapterError: { cause: { originalCode: pgCode } } },
      });

    it.each(['40P01', '40001', '55P03'])(
      '%s una vez: se reintenta dentro del servidor y la reserva sale (una sola)',
      async (pgCode) => {
        const shop = await shopReady();
        const me = await verifiedClient();
        const db = app.get(PrismaService);
        const original = db.$transaction.bind(db);
        const spy = jest
          .spyOn(db, '$transaction')
          .mockImplementationOnce(() => Promise.reject(dbError(pgCode)))
          .mockImplementation(original);
        try {
          await book(me, shop, at('10:00')).expect(201);
        } finally {
          spy.mockRestore();
        }
        expect(await prisma.booking.count({ where: { clientId: me.userId } })).toBe(1);
      },
    );

    it('si la contención persiste tras el reintento: 503 reintentable', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const db = app.get(PrismaService);
      const spy = jest.spyOn(db, '$transaction').mockRejectedValue(dbError('40P01'));
      let res;
      let calls: number | undefined;
      try {
        res = await book(me, shop, at('10:00')).expect(503);
      } finally {
        calls = spy.mock.calls.length;
        spy.mockRestore();
      }
      expect(res.body).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        details: [{ retryable: true }],
      });
      expect(calls).toBe(2); // un intento y un reintento
      // Reintentar con la misma petición funciona.
      await book(me, shop, at('10:00')).expect(201);
    });

    it('la violación de exclusión que escapa del recorrido de candidatos sigue siendo 409', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const db = app.get(PrismaService);
      const spy = jest.spyOn(db, '$transaction').mockRejectedValue(dbError('23P01'));
      try {
        const res = await book(me, shop, at('10:00')).expect(409);
        expect(res.body.code).toBe('SLOT_NOT_AVAILABLE');
      } finally {
        spy.mockRestore();
      }
    });

    it('55P03 real: un bloqueo retenido por otra conexión agota lock_timeout → 503, luego 201', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      // Otra conexión retiene el bloqueo consultivo del cliente (el primero que toma la reserva).
      const holder = new PgClient({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [`booking-client:${me.userId}`]);
      const started = Date.now();
      try {
        const res = await book(me, shop, at('10:00')).expect(503);
        expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
        // Dos intentos de LOCK_TIMEOUT_MS cada uno, no los 20 s del plazo de la transacción.
        expect(Date.now() - started).toBeLessThan(2 * LOCK_TIMEOUT_MS + 5_000);
      } finally {
        await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [
          `booking-client:${me.userId}`,
        ]);
        await holder.end();
      }
      await book(me, shop, at('10:00')).expect(201);
    }, 60_000);
  });

  describe('vencimiento de reservas sin pago', () => {
    it('al crear una reserva se vence, en la misma transacción, la PENDING_PAYMENT vencida que se solapa', async () => {
      const shop = await shopReady();
      const old = await book(await verifiedClient(), shop, at('10:00')).expect(201);
      clock.current += 11 * MINUTE; // venció, pero aún no está EXPIRED
      const fresh = await book(await verifiedClient(), shop, at('10:00')).expect(201);
      const expired = await prisma.booking.findUniqueOrThrow({ where: { id: old.body.id } });
      expect(expired.status).toBe('EXPIRED');
      expect((await history(old.body.id)).map((h) => h.toStatus)).toEqual([
        'PENDING_PAYMENT',
        'EXPIRED',
      ]);
      expect(await eventsOf(old.body.id)).toEqual(['booking.created', 'booking.expired']);
      expect(fresh.body.status).toBe('PENDING_PAYMENT');
    });

    it('el trabajo programado vence solo las vencidas, libera el turno y es idempotente', async () => {
      const shop = await shopReady();
      const due = await book(await verifiedClient(), shop, at('10:00')).expect(201);
      clock.current += 5 * MINUTE;
      const alive = await book(await verifiedClient(), shop, at('11:00')).expect(201);
      clock.current += 6 * MINUTE; // la primera venció (11 min); la segunda no (6 min)
      const job = app.get(BookingExpirationService);
      // Puede vencer reservas de otras pruebas de esta suite; lo que importa son estas dos.
      expect(await job.expireDue()).toBeGreaterThanOrEqual(1);
      expect(await job.expireDue()).toBe(0);
      const statuses = await prisma.booking.findMany({
        where: { id: { in: [due.body.id, alive.body.id] } },
        select: { id: true, status: true },
      });
      expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({
        [due.body.id]: 'EXPIRED',
        [alive.body.id]: 'PENDING_PAYMENT',
      });
      const rows = await history(due.body.id);
      expect(rows.map((h) => [h.toStatus, h.reason, h.changedById])).toEqual([
        ['PENDING_PAYMENT', null, expect.any(String)],
        ['EXPIRED', 'payment_timeout', null],
      ]);
      const slots = await new AuthClient(app)
        .get(
          `${SHOPS}/${shop.owner.shopId}/availability?serviceId=${shop.serviceId}&date=${MONDAY}`,
        )
        .expect(200);
      expect(slots.body.slots.map((s: { startAt: string }) => s.startAt)).toContain(at('10:00'));
    });

    it('procesa por lotes', async () => {
      const shop = await shopReady();
      for (const hhmm of ['09:00', '09:30', '10:00']) {
        await book(await verifiedClient(), shop, at(hhmm)).expect(201);
      }
      clock.current += 11 * MINUTE;
      expect(await app.get(BookingExpirationService).expireDue(2)).toBe(3);
    });
  });

  describe('RF-RES-003 / RF-PAG-001 pago (FakeGateway)', () => {
    it('RF-RES-003 solo un pago confirmado confirma la reserva; el resultado repetido no cambia nada', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const res = await book(me, shop, at('10:00')).expect(201);
      const paymentId = res.body.payment.paymentId as string;
      expect((await pay(paymentId, 'SUCCEEDED').expect(200)).body).toEqual({
        received: true,
        duplicate: false,
      });
      // Un resultado posterior distinto no cambia un pago que ya no está PENDING.
      await pay(paymentId, 'REJECTED').expect(200);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
        'SUCCEEDED',
      );
      const booking = await me.client.get(`${API}/bookings/${res.body.id}`, me.token).expect(200);
      expect(booking.body).toMatchObject({ status: 'CONFIRMED', expiresAt: null });
      expect((await history(res.body.id)).map((h) => [h.toStatus, h.changedById])).toEqual([
        ['PENDING_PAYMENT', me.userId],
        ['CONFIRMED', null],
      ]);
      expect(await eventsOf(res.body.id)).toEqual(['booking.created', 'booking.confirmed']);
      // Ya no se puede iniciar otro pago.
      expect(
        (await me.client.post(`${API}/bookings/${res.body.id}/payment`, {}, me.token).expect(409))
          .body.code,
      ).toBe('PAYMENT_NOT_AVAILABLE');
    });

    it('RF-RES-003 pago rechazado: la reserva se cancela (sistema) y el turno se libera', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const res = await book(me, shop, at('10:00')).expect(201);
      await pay(res.body.payment.paymentId, 'REJECTED').expect(200);
      const booking = await me.client.get(`${API}/bookings/${res.body.id}`, me.token).expect(200);
      expect(booking.body).toMatchObject({
        status: 'CANCELLED',
        cancellation: { byRole: 'SYSTEM', reason: 'payment_rejected' },
      });
      await book(await verifiedClient(), shop, at('10:00')).expect(201);
    });

    it('un pago confirmado tras el vencimiento no reactiva la reserva: queda huérfano para reembolso', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const res = await book(me, shop, at('10:00')).expect(201);
      clock.current += 11 * MINUTE;
      await app.get(BookingExpirationService).expireDue();
      expect(
        (await me.client.post(`${API}/bookings/${res.body.id}/payment`, {}, me.token).expect(409))
          .body.code,
      ).toBe('PAYMENT_NOT_AVAILABLE');
      await pay(res.body.payment.paymentId, 'SUCCEEDED').expect(200);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: res.body.id } })).status).toBe(
        'EXPIRED',
      );
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: res.body.payment.paymentId },
      });
      expect(payment.status).toBe('SUCCEEDED');
      expect(payment.metadata).toMatchObject({ refundDecision: 'ORPHANED' });
      const refunds = await prisma.refund.findMany({ where: { paymentId: payment.id } });
      expect(refunds.map((r) => [r.reasonType, r.amount, r.status])).toEqual([
        ['ORPHANED_PAYMENT', 2500, 'PENDING'],
      ]);
      const orphaned = await prisma.outboxEvent.findMany({ where: { type: 'payment.orphaned' } });
      expect(
        orphaned.some((e) => (e.payload as { paymentId: string }).paymentId === payment.id),
      ).toBe(true);
    });

    it('A: la pasarela se llama después del commit; si falla, la reserva existe y el pago se reintenta', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      app.get(FakeGateway).failNextCalls(2);
      const res = await book(me, shop, at('10:00')).expect(201);
      expect(res.body.payment).toMatchObject({ status: 'PENDING', clientAction: null });
      const retryFails = await me.client
        .post(`${API}/bookings/${res.body.id}/payment`, {}, me.token)
        .expect(502);
      expect(retryFails.body.code).toBe('PAYMENT_PROVIDER_ERROR');
      const ok = await me.client
        .post(`${API}/bookings/${res.body.id}/payment`, {}, me.token)
        .expect(200);
      const again = await me.client
        .post(`${API}/bookings/${res.body.id}/payment`, {}, me.token)
        .expect(200);
      expect(ok.body).toMatchObject({
        paymentId: res.body.payment.paymentId,
        clientAction: { type: 'FAKE' },
      });
      expect(again.body).toEqual(ok.body);
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: res.body.payment.paymentId },
      });
      expect(payment.providerPaymentId).toMatch(/^fake_/);
      // Otro cliente no puede iniciar el pago de esta reserva.
      const other = await verifiedClient();
      await other.client
        .post(`${API}/bookings/${res.body.id}/payment`, {}, other.token)
        .expect(404);
    });

    it('webhook de un pago inexistente: 409 WEBHOOK_MISMATCH, sin efectos', async () => {
      expect((await pay(randomUUID(), 'SUCCEEDED').expect(409)).body.code).toBe('WEBHOOK_MISMATCH');
    });
  });

  describe('RF-RES-005 cancelar', () => {
    async function confirmed(shop: Shop, who: Client, hhmm = '10:00') {
      const res = await book(who, shop, at(hhmm)).expect(201);
      await pay(res.body.payment.paymentId, 'SUCCEEDED').expect(200);
      return res.body as { id: string; payment: { paymentId: string } };
    }
    const cancel = (who: { client: AuthClient; token: string }, id: string, reason?: string) =>
      who.client.post(`${API}/bookings/${id}/cancel`, reason ? { reason } : {}, who.token);

    it('RF-RES-005 el cliente cancela una confirmada con 2 h de anticipación: devolución del 50 %', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await confirmed(shop, me); // 10:00; reloj a las 08:00 → 120 min
      const preview = await me.client
        .get(`${API}/bookings/${booking.id}/cancellation-preview`, me.token)
        .expect(200);
      expect(preview.body).toEqual({
        allowed: true,
        reason: null,
        reasonRequired: false,
        refund: {
          amount: { amount: 1250, currency: 'PEN' },
          percent: 50,
          rule: 'CLIENT_PARTIAL',
          paid: { amount: 2500, currency: 'PEN' },
        },
      });
      const res = await cancel(me, booking.id).expect(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        cancellation: { byRole: 'CLIENT', reason: null },
        refund: preview.body.refund,
      });
      const refunds = await prisma.refund.findMany({
        where: { paymentId: booking.payment.paymentId },
      });
      expect(refunds.map((r) => [r.reasonType, r.amount, r.status])).toEqual([
        ['CLIENT_CANCELLATION', 1250, 'PENDING'],
      ]);
      expect(await eventsOf(booking.id)).toEqual([
        'booking.created',
        'booking.confirmed',
        'booking.cancelled',
      ]);
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(row.cancelledById).toBe(me.userId);
      expect(row.cancelledByRole).toBe('CLIENT');
      expect(row.metadata).not.toHaveProperty('cancelledByRole');
      // El turno vuelve a estar libre.
      await book(await verifiedClient(), shop, at('10:00')).expect(201);
    });

    it('la base exige el rol si y solo si la reserva está cancelada (bookings_cancelled_by_role_check)', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const res = await book(me, shop, at('10:00')).expect(201);
      await expectConstraintViolation(
        prisma.booking.update({ where: { id: res.body.id }, data: { status: 'CANCELLED' } }),
        'bookings_cancelled_by_role_check',
      );
      await expectConstraintViolation(
        prisma.booking.update({ where: { id: res.body.id }, data: { cancelledByRole: 'CLIENT' } }),
        'bookings_cancelled_by_role_check',
      );
    });

    it('RF-RES-005 el cliente cancela una pendiente de pago siempre', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const res = await book(me, shop, at('09:00')).expect(201);
      clock.current = lima(MONDAY, '08:59');
      await cancel(me, res.body.id).expect(200);
    });

    it('RF-RES-005 flujos alternativos: ya empezó, ya cancelada; con menos de 2 h, sin devolución', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await confirmed(shop, me, '09:00');
      clock.current = lima(MONDAY, '09:00');
      expect((await cancel(me, booking.id).expect(409)).body.code).toBe('CANCELLATION_NOT_ALLOWED');
      clock.current = lima(MONDAY, '08:30');
      const late = await cancel(me, booking.id).expect(200);
      expect(late.body.refund).toMatchObject({ rule: 'CLIENT_NONE', amount: { amount: 0 } });
      expect((await cancel(me, booking.id).expect(409)).body.code).toBe('ALREADY_CANCELLED');
    });

    it('la barbería cancela: devolución total y la cancelación queda registrada para revisión', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await confirmed(shop, me, '10:00');
      clock.current = lima(MONDAY, '09:50'); // 10 min antes: aun así, total
      const res = await cancel(shop.owner, booking.id, 'El barbero está enfermo').expect(200);
      expect(res.body.cancellation).toEqual({
        byRole: 'BARBERSHOP',
        reason: 'El barbero está enfermo',
      });
      expect(res.body.refund).toMatchObject({ rule: 'BARBERSHOP_CANCELLATION', percent: 100 });
      expect(res.body.client).toMatchObject({ id: me.userId });
      const review = await prisma.barbershopCancellationReview.findUniqueOrThrow({
        where: { bookingId: booking.id },
      });
      expect(review).toMatchObject({
        barbershopId: shop.owner.shopId,
        cancelledById: shop.owner.userId,
        status: 'PENDING_REVIEW',
      });
    });

    it('la cancelación de la barbería de una reserva sin pagar también se registra', async () => {
      const shop = await shopReady();
      const res = await book(await verifiedClient(), shop, at('10:00')).expect(201);
      const cancelled = await cancel(shop.owner, res.body.id, 'Cierre imprevisto').expect(200);
      expect(cancelled.body.refund).toMatchObject({ rule: 'NO_PAYMENT', amount: { amount: 0 } });
      expect(
        await prisma.barbershopCancellationReview.count({ where: { bookingId: res.body.id } }),
      ).toBe(1);
    });

    it('la barbería debe dar un motivo; el barbero no puede cancelar; un tercero recibe 404', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = await confirmed(shop, me);
      const noReason = await cancel(shop.owner, booking.id).expect(400);
      expect(noReason.body.details).toEqual([
        { field: 'reason', constraints: ['requiredForBarbershop'] },
      ]);
      const barber = await linkedBarberAccount(shop);
      expect((await cancel(barber, booking.id, 'No puedo').expect(403)).body.code).toBe(
        'FORBIDDEN',
      );
      await cancel(await verifiedClient(), booking.id).expect(404);
    });
  });

  /** Cuenta vinculada como barbero (por invitación) al primer barbero de la barbería. */
  async function linkedBarberAccount(shop: Shop): Promise<Client> {
    const account = await verifiedClient();
    // Atajo de datos de prueba: la vinculación por invitación ya se prueba en la Fase 4.
    await prisma.barber.update({
      where: { id: shop.barberIds[0] },
      data: { userId: account.userId },
    });
    return account;
  }

  describe('RF-RES-004 / RF-RES-008 consultar', () => {
    it('RF-RES-004 cada rol ve solo lo que le corresponde; el personal ve el nombre del cliente y nada más', async () => {
      const shop = await shopReady();
      const me = await verifiedClient();
      const booking = (await book(me, shop, at('10:00')).expect(201)).body;
      const mine = await me.client.get(`${API}/me/bookings`, me.token).expect(200);
      expect(mine.body.items.map((b: { id: string }) => b.id)).toEqual([booking.id]);
      expect(mine.body.items[0].client).toBeNull();

      const shopList = await shop.owner.client
        .get(`${SHOPS}/${shop.owner.shopId}/bookings`, shop.owner.token)
        .expect(200);
      expect(shopList.body.items[0].client).toEqual({
        id: me.userId,
        name: 'Persona',
        username: expect.any(String),
        photoUrl: null,
      });
      const raw = JSON.stringify(shopList.body);
      expect(raw).not.toMatch(/@example|phone|email|document/i);

      const barber = await linkedBarberAccount(shop);
      const barberList = await barber.client
        .get(`${API}/me/barber/bookings`, barber.token)
        .expect(200);
      expect(barberList.body.items.map((b: { id: string }) => b.id)).toEqual([booking.id]);
      await barber.client.get(`${API}/bookings/${booking.id}`, barber.token).expect(200);

      const stranger = await verifiedClient();
      await stranger.client.get(`${API}/bookings/${booking.id}`, stranger.token).expect(404);
      await stranger.client
        .get(`${SHOPS}/${shop.owner.shopId}/bookings`, stranger.token)
        .expect(404);
      expect(
        (await stranger.client.get(`${API}/me/bookings`, stranger.token).expect(200)).body.items,
      ).toEqual([]);
      await new AuthClient(app).get(`${API}/me/bookings`).expect(401);
    });

    it('RF-RES-008 historial: estados finales y pasadas, la más reciente primero; próximas en orden', async () => {
      const shop = await shopReady(2);
      const me = await verifiedClient();
      const a = (await book(me, shop, at('09:00')).expect(201)).body;
      const b = (await book(me, shop, at('11:00')).expect(201)).body;
      await pay(a.payment.paymentId, 'SUCCEEDED').expect(200);
      await pay(b.payment.paymentId, 'SUCCEEDED').expect(200);
      const c = (await book(me, shop, at('10:00')).expect(201)).body;
      await me.client.post(`${API}/bookings/${c.id}/cancel`, {}, me.token).expect(200);

      const upcoming = await me.client
        .get(`${API}/me/bookings?scope=upcoming`, me.token)
        .expect(200);
      expect(upcoming.body.items.map((x: { id: string }) => x.id)).toEqual([a.id, b.id]);
      clock.current = lima(MONDAY, '10:00');
      const history = await me.client.get(`${API}/me/bookings?scope=history`, me.token).expect(200);
      expect(
        history.body.items.map((x: { id: string; status: string }) => [x.id, x.status]),
      ).toEqual([
        [c.id, 'CANCELLED'],
        [a.id, 'CONFIRMED'],
      ]);
    });

    it('paginación por cursor sin repetidos', async () => {
      const shop = await shopReady(2);
      const people = await Promise.all([verifiedClient(), verifiedClient()]);
      const ids: string[] = [];
      for (const [i, hhmm] of ['09:00', '09:30', '10:00', '10:30'].entries()) {
        ids.push((await book(people[i % 2]!, shop, at(hhmm)).expect(201)).body.id);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: { body: { items: { id: string }[]; nextCursor: string | null } } =
          await shop.owner.client
            .get(
              `${SHOPS}/${shop.owner.shopId}/bookings?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
              shop.owner.token,
            )
            .expect(200);
        seen.push(...res.body.items.map((x: { id: string }) => x.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(ids);
      await shop.owner.client
        .get(`${SHOPS}/${shop.owner.shopId}/bookings?cursor=basura`, shop.owner.token)
        .expect(400);
    }, 60_000);
  });
});
