import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DateTime } from 'luxon';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { BookingAttendanceService } from '../../src/modules/bookings/booking-attendance.service';
import { FAKE_SIGNATURE_HEADER, FakeGateway } from '../../src/modules/payments/fake-gateway';
import { AuthClient, codeFrom, createAuthTestApp, waitForMail } from '../support/auth';
import { ownerWithShop } from '../support/barbershops';

const API = '/api/v1';
const SHOPS = `${API}/barbershops`;
const LIMA = 'America/Lima';
const MONDAY = '2030-01-07';
const lima = (date: string, hhmm: string) =>
  DateTime.fromISO(`${date}T${hhmm}`, { zone: LIMA }).toMillis();
const at = (hhmm: string, date = MONDAY) => new Date(lima(date, hhmm)).toISOString();
const HOUR = 3_600_000;

interface Person {
  client: AuthClient;
  token: string;
  userId: string;
}

describe('RF-ATE-001…003 Atención, inasistencias, corrección y agenda — Fase 9 (e2e)', () => {
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

  async function verified(): Promise<Person> {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    const code = codeFrom(await waitForMail(app, email, 'welcome-verification'));
    await client
      .post(`${API}/auth/email-verification/confirm`, { code }, tokens.accessToken)
      .expect(204);
    return { client, token: tokens.accessToken, userId: tokens.user.id };
  }

  /** Barbería con un barbero vinculado a una cuenta, horario lunes 09:00–13:00. */
  async function shopReady() {
    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    const service = await client
      .post(
        `${SHOPS}/${owner.shopId}/services`,
        { name: 'Corte', priceAmount: 2500, durationMinutes: 30, categoryKey: 'haircut' },
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
    const barberAccount = await verified();
    // Atajo de datos de prueba: la vinculación por invitación ya se prueba en la Fase 4.
    await prisma.barber.update({
      where: { id: barber.body.id },
      data: { userId: barberAccount.userId },
    });
    return {
      owner: { ...owner, client },
      serviceId: service.body.id as string,
      barberId: barber.body.id as string,
      barber: barberAccount,
    };
  }
  type Shop = Awaited<ReturnType<typeof shopReady>>;

  async function book(shop: Shop, hhmm: string, who?: Person) {
    const person = who ?? (await verified());
    const res = await person.client
      .post(
        `${API}/bookings`,
        {
          barbershopId: shop.owner.shopId,
          serviceId: shop.serviceId,
          startAt: at(hhmm),
          barberId: shop.barberId,
        },
        person.token,
      )
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return { id: res.body.id as string, paymentId: res.body.payment.paymentId as string, person };
  }

  async function confirmed(shop: Shop, hhmm: string) {
    const booking = await book(shop, hhmm);
    const { rawBody, signature } = app
      .get(FakeGateway)
      .settlePayment(booking.paymentId, 'SUCCEEDED');
    const sender = new AuthClient(app);
    await sender.http
      .post(`${API}/payments/webhooks/fake`)
      .set('X-Forwarded-For', sender.ip)
      .set('Content-Type', 'application/json')
      .set(FAKE_SIGNATURE_HEADER, signature)
      .send(rawBody)
      .expect(200);
    return booking;
  }

  const statusOf = async (id: string) =>
    (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
  const attended = (who: { client: AuthClient; token: string }, id: string) =>
    who.client.post(`${API}/bookings/${id}/attended`, {}, who.token);
  const correct = (
    who: { client: AuthClient; token: string },
    id: string,
    body: Record<string, unknown>,
  ) => who.client.post(`${API}/bookings/${id}/attendance-correction`, body, who.token);

  describe('RF-ATE-002 marcar como atendida', () => {
    it('RF-ATE-002 el barbero asignado la marca desde la hora de inicio', async () => {
      const shop = await shopReady();
      const booking = await confirmed(shop, '10:00');
      clock.current = lima(MONDAY, '09:59');
      expect((await attended(shop.barber, booking.id).expect(409)).body.code).toBe(
        'ATTENDANCE_NOT_ALLOWED',
      );
      clock.current = lima(MONDAY, '10:00');
      const res = await attended(shop.barber, booking.id).expect(200);
      expect(res.body.status).toBe('ATTENDED');
      const history = await prisma.bookingStatusHistory.findMany({
        where: { bookingId: booking.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.at(-1)).toMatchObject({
        fromStatus: 'CONFIRMED',
        toStatus: 'ATTENDED',
        changedById: shop.barber.userId,
      });
      // Ya no se puede volver a marcar.
      await attended(shop.barber, booking.id).expect(409);
    });

    it('la barbería también la marca; hasta 24 h después del inicio, no más', async () => {
      const shop = await shopReady();
      const a = await confirmed(shop, '10:00');
      const b = await confirmed(shop, '11:00');
      clock.current = lima(MONDAY, '10:00') + 24 * HOUR;
      await attended(shop.owner, a.id).expect(200);
      clock.current = lima(MONDAY, '11:00') + 24 * HOUR + 1;
      await attended(shop.owner, b.id).expect(409);
    });

    it('el cliente no puede (403); un tercero no la ve (404); una pendiente de pago no se marca', async () => {
      const shop = await shopReady();
      const booking = await confirmed(shop, '10:00');
      const pending = await book(shop, '11:00');
      clock.current = lima(MONDAY, '11:30');
      expect((await attended(booking.person, booking.id).expect(403)).body.code).toBe('FORBIDDEN');
      await attended(await verified(), booking.id).expect(404);
      expect((await attended(shop.owner, pending.id).expect(409)).body.code).toBe(
        'ATTENDANCE_NOT_ALLOWED',
      );
    });

    it('asistencia e inasistencia a la vez: solo una gana', async () => {
      const shop = await shopReady();
      const booking = await confirmed(shop, '10:00');
      clock.current = lima(MONDAY, '10:30');
      const results = await Promise.all([
        attended(shop.barber, booking.id),
        shop.owner.client.post(`${API}/bookings/${booking.id}/no-show`, {}, shop.owner.token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(['ATTENDED', 'NO_SHOW']).toContain(await statusOf(booking.id));
    });
  });

  describe('cierre automático de las CONFIRMED sin marcar', () => {
    it('pasadas 24 h del inicio, quedan ATTENDED (sistema, auto_close); idempotente', async () => {
      const shop = await shopReady();
      const old = await confirmed(shop, '09:00');
      const recent = await confirmed(shop, '12:00');
      const pending = await book(shop, '10:00');
      clock.current = lima(MONDAY, '09:00') + 24 * HOUR + 60_000; // la de 12:00 aún no
      const job = app.get(BookingAttendanceService);
      expect(await job.autoCloseDue()).toBeGreaterThanOrEqual(1);
      expect(await job.autoCloseDue()).toBe(0);
      expect(await statusOf(old.id)).toBe('ATTENDED');
      expect(await statusOf(recent.id)).toBe('CONFIRMED');
      expect(await statusOf(pending.id)).toBe('PENDING_PAYMENT');
      const last = await prisma.bookingStatusHistory.findFirstOrThrow({
        where: { bookingId: old.id, toStatus: 'ATTENDED' },
      });
      expect(last).toMatchObject({ changedById: null, reason: 'auto_close' });
    });

    it('procesa por lotes', async () => {
      const shop = await shopReady();
      for (const hhmm of ['09:00', '09:30', '10:00']) await confirmed(shop, hhmm);
      clock.current = lima(MONDAY, '10:00') + 25 * HOUR;
      expect(await app.get(BookingAttendanceService).autoCloseDue(2)).toBeGreaterThanOrEqual(3);
    });
  });

  describe('corrección ATTENDED ↔ NO_SHOW', () => {
    it('el responsable corrige con motivo dentro de 48 h; queda en historial, auditoría y evento', async () => {
      const shop = await shopReady();
      const booking = await confirmed(shop, '10:00');
      clock.current = lima(MONDAY, '10:30');
      await attended(shop.barber, booking.id).expect(200);
      clock.current = lima(MONDAY, '10:00') + 47 * HOUR;
      const res = await correct(shop.owner, booking.id, {
        status: 'NO_SHOW',
        reason: 'El barbero marcó por error',
      }).expect(200);
      expect(res.body.status).toBe('NO_SHOW');
      const history = await prisma.bookingStatusHistory.findFirstOrThrow({
        where: { bookingId: booking.id, toStatus: 'NO_SHOW' },
      });
      expect(history).toMatchObject({
        fromStatus: 'ATTENDED',
        changedById: shop.owner.userId,
        reason: 'correction: El barbero marcó por error',
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'booking.attendance_corrected', entityId: booking.id },
      });
      expect(audit).toMatchObject({ actorId: shop.owner.userId });
      expect(audit.changes).toMatchObject({
        values: { status: { from: 'ATTENDED', to: 'NO_SHOW' } },
      });
      const events = await prisma.outboxEvent.findMany({
        where: { type: 'booking.attendance_corrected' },
      });
      expect(
        events.some((e) => (e.payload as { bookingId: string }).bookingId === booking.id),
      ).toBe(true);
      // Y de vuelta.
      await correct(shop.owner, booking.id, { status: 'ATTENDED', reason: 'Sí vino' }).expect(200);
      expect(await statusOf(booking.id)).toBe('ATTENDED');
    });

    it('también se corrige un cierre automático', async () => {
      const shop = await shopReady();
      const booking = await confirmed(shop, '10:00');
      clock.current = lima(MONDAY, '10:00') + 25 * HOUR;
      await app.get(BookingAttendanceService).autoCloseDue();
      await correct(shop.owner, booking.id, { status: 'NO_SHOW', reason: 'No vino' }).expect(200);
    });

    it('el barbero no corrige (403); pasado el plazo, 409; sin motivo, 400; no es una transición libre', async () => {
      const shop = await shopReady();
      const booking = await confirmed(shop, '10:00');
      const other = await confirmed(shop, '12:00');
      clock.current = lima(MONDAY, '10:30');
      await attended(shop.barber, booking.id).expect(200);
      expect(
        (await correct(shop.barber, booking.id, { status: 'NO_SHOW', reason: 'error' }).expect(403))
          .body.code,
      ).toBe('FORBIDDEN');
      await correct(shop.owner, booking.id, { status: 'NO_SHOW' }).expect(400);
      // ATTENDED → ATTENDED no es una corrección.
      expect(
        (await correct(shop.owner, booking.id, { status: 'ATTENDED', reason: 'igual' }).expect(409))
          .body.code,
      ).toBe('INVALID_STATE_TRANSITION');
      clock.current = lima(MONDAY, '10:00') + 48 * HOUR + 1;
      expect(
        (await correct(shop.owner, booking.id, { status: 'NO_SHOW', reason: 'tarde' }).expect(409))
          .body.code,
      ).toBe('ATTENDANCE_CORRECTION_NOT_ALLOWED');
      // Una reserva confirmada sin marcar no se "corrige".
      clock.current = lima(MONDAY, '12:30');
      await correct(shop.owner, other.id, { status: 'NO_SHOW', reason: 'x y z' }).expect(409);
    });
  });

  describe('RF-ATE-001 agenda del día', () => {
    it('RF-ATE-001 el barbero ve su día: reservas, bloqueos, pendientes de atención y acciones', async () => {
      const shop = await shopReady();
      const done = await confirmed(shop, '09:00');
      const due = await confirmed(shop, '10:00');
      const later = await confirmed(shop, '12:00');
      const cancelled = await book(shop, '12:30');
      await cancelled.person.client
        .post(`${API}/bookings/${cancelled.id}/cancel`, {}, cancelled.person.token)
        .expect(200);
      await shop.owner.client
        .post(
          `${SHOPS}/${shop.owner.shopId}/time-blocks`,
          {
            barberId: shop.barberId,
            startAt: at('11:30'),
            endAt: at('12:00'),
            type: 'BREAK',
            reason: 'Almuerzo',
          },
          shop.owner.token,
        )
        .expect(201);
      clock.current = lima(MONDAY, '10:30');
      await attended(shop.barber, done.id).expect(200);
      // Pendiente de pago vigente (vence a las 10:40): aparece como "por confirmar".
      const pending = await book(shop, '11:00');

      const res = await shop.barber.client
        .get(`${API}/me/barber/agenda`, shop.barber.token)
        .expect(200);
      expect(res.body).toMatchObject({
        date: MONDAY,
        timezone: LIMA,
        barbershop: { id: shop.owner.shopId },
        pendingAttention: 1,
      });
      const items = res.body.items as {
        bookingId: string;
        status: string;
        awaitingPayment: boolean;
        pendingAttention: boolean;
        client: { id: string; name: string; photoUrl: string | null };
        actions: { canMarkAttended: boolean; canMarkNoShow: boolean; canCorrect: boolean };
      }[];
      expect(items.map((i) => i.bookingId)).toEqual([done.id, due.id, pending.id, later.id]);
      const byId = Object.fromEntries(items.map((i) => [i.bookingId, i]));
      expect(byId[due.id]).toMatchObject({
        status: 'CONFIRMED',
        pendingAttention: true,
        actions: { canMarkAttended: true, canMarkNoShow: true, canCorrect: false },
      });
      expect(byId[pending.id]).toMatchObject({ awaitingPayment: true, pendingAttention: false });
      expect(byId[later.id]!.actions).toEqual({
        canMarkAttended: false,
        canMarkNoShow: false,
        canCorrect: false,
        canCancel: false, // el barbero nunca cancela
      });
      // El barbero nunca puede corregir.
      expect(byId[done.id]!.actions.canCorrect).toBe(false);
      expect(res.body.blocks).toEqual([
        expect.objectContaining({ barberId: shop.barberId, type: 'BREAK', reason: 'Almuerzo' }),
      ]);
      // Solo el nombre del cliente.
      expect(byId[due.id]!.client).toEqual({
        id: due.person.userId,
        name: 'Persona',
        username: expect.any(String),
        photoUrl: null,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/@example|phone|email|document/i);
    });

    it('el responsable ve la agenda de la barbería, con corrección disponible y filtro por barbero', async () => {
      const shop = await shopReady();
      const done = await confirmed(shop, '09:00');
      clock.current = lima(MONDAY, '09:30');
      await attended(shop.owner, done.id).expect(200);
      const res = await shop.owner.client
        .get(`${SHOPS}/${shop.owner.shopId}/agenda?barberId=${shop.barberId}`, shop.owner.token)
        .expect(200);
      expect(res.body.items[0]).toMatchObject({
        bookingId: done.id,
        status: 'ATTENDED',
        actions: { canCorrect: true },
      });
      // Otro día: vacío.
      const tuesday = await shop.owner.client
        .get(`${SHOPS}/${shop.owner.shopId}/agenda?date=2030-01-08`, shop.owner.token)
        .expect(200);
      expect(tuesday.body).toMatchObject({ date: '2030-01-08', items: [], pendingAttention: 0 });
      await shop.owner.client
        .get(`${SHOPS}/${shop.owner.shopId}/agenda?barberId=${randomUUID()}`, shop.owner.token)
        .expect(404);
    });

    it('el día es el local de la barbería (no el UTC)', async () => {
      const shop = await shopReady();
      await confirmed(shop, '12:30'); // 17:30 UTC del lunes
      // 23:30 del lunes en Lima = 04:30 UTC del martes: "hoy" sigue siendo lunes.
      clock.current = lima(MONDAY, '23:30');
      const res = await shop.barber.client
        .get(`${API}/me/barber/agenda`, shop.barber.token)
        .expect(200);
      expect(res.body.date).toBe(MONDAY);
      expect(res.body.items).toHaveLength(1);
    });

    it('acceso: un no miembro recibe 404; quien no es barbero, 404; sin sesión, 401; fecha inválida, 400', async () => {
      const shop = await shopReady();
      const stranger = await verified();
      await stranger.client.get(`${SHOPS}/${shop.owner.shopId}/agenda`, stranger.token).expect(404);
      await stranger.client.get(`${API}/me/barber/agenda`, stranger.token).expect(404);
      await new AuthClient(app).get(`${API}/me/barber/agenda`).expect(401);
      await shop.barber.client
        .get(`${API}/me/barber/agenda?date=07-01-2030`, shop.barber.token)
        .expect(400);
    });
  });
});
