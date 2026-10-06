import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DateTime } from 'luxon';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AvailabilityService } from '../../src/modules/availability/availability.service';
import { AuthClient, codeFrom, createAuthTestApp, waitForMail } from '../support/auth';
import { ownerWithShop } from '../support/barbershops';

const SHOPS = '/api/v1/barbershops';
const LIMA = 'America/Lima';
const MONDAY = '2030-01-07';
const TUESDAY = '2030-01-08';

/** Instante de una hora local de Lima. */
const lima = (date: string, hhmm: string) =>
  DateTime.fromISO(`${date}T${hhmm}`, { zone: LIMA }).toMillis();
/** Horas locales de inicio de los turnos de una respuesta. */
const startsOf = (res: { body: unknown }): string[] =>
  (res.body as { slots: { startAt: string }[] }).slots.map((x) => hhmm(x.startAt));
const hhmm = (iso: string) => DateTime.fromISO(iso, { zone: LIMA }).toFormat('HH:mm');

describe('RF-DIS-001…004 y RF-BRB-003 Horarios, bloqueos y disponibilidad (e2e)', () => {
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

  /** Barbería con horario lun–mar 09:00–13:00, un servicio de 30 min y un barbero que lo realiza. */
  async function shopReady(options: { days?: number[] } = {}) {
    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    const service = await client
      .post(
        `${SHOPS}/${owner.shopId}/services`,
        { name: 'Corte', priceAmount: 2500, durationMinutes: 30 },
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
    const days = (options.days ?? [1, 2]).map((dayOfWeek) => ({
      dayOfWeek,
      windows: [{ start: '09:00', end: '13:00' }],
    }));
    await client.put(`${SHOPS}/${owner.shopId}/business-hours`, { days }, owner.token).expect(200);
    return {
      client,
      owner,
      serviceId: service.body.id as string,
      barberId: barber.body.id as string,
      day: (date: string, extra = '') =>
        new AuthClient(app).get(
          `${SHOPS}/${owner.shopId}/availability?serviceId=${service.body.id}&date=${date}${extra}`,
        ),
    };
  }

  async function booking(
    s: { owner: { shopId: string; userId: string }; serviceId: string; barberId: string },
    start: number,
    overrides: { status?: 'CONFIRMED' | 'PENDING_PAYMENT' | 'CANCELLED'; expiresAt?: Date } = {},
  ) {
    return prisma.booking.create({
      data: {
        clientId: s.owner.userId,
        barbershopId: s.owner.shopId,
        barberId: s.barberId,
        serviceId: s.serviceId,
        startAt: new Date(start),
        endAt: new Date(start + 30 * 60_000),
        status: overrides.status ?? 'CONFIRMED',
        expiresAt:
          overrides.expiresAt ??
          (overrides.status === 'PENDING_PAYMENT' ? new Date(clock.current + 600_000) : null),
        barberChosenByClient: true,
        serviceNameSnapshot: 'Corte',
        durationMinutesSnapshot: 30,
        subtotalAmount: 2500,
        totalAmount: 2500,
        currency: 'PEN',
        idempotencyKey: randomUUID(),
      },
    });
  }

  describe('RF-DIS-001 horario de la barbería', () => {
    it('RF-DIS-001 configura la semana y se publica con "abierta ahora" calculado', async () => {
      const s = await shopReady();
      const visitor = new AuthClient(app);
      const res = await visitor.get(`${SHOPS}/${s.owner.shopId}/business-hours`).expect(200);
      expect(res.body).toEqual({
        timezone: LIMA,
        isOpenNow: false, // lunes 08:00
        days: [
          { dayOfWeek: 1, windows: [{ start: '09:00', end: '13:00' }] },
          { dayOfWeek: 2, windows: [{ start: '09:00', end: '13:00' }] },
        ],
      });
      clock.current = lima(MONDAY, '10:00');
      expect(
        (await visitor.get(`${SHOPS}/${s.owner.shopId}/business-hours`).expect(200)).body.isOpenNow,
      ).toBe(true);
    });

    it.each([
      [
        'ventanas solapadas',
        [
          {
            dayOfWeek: 1,
            windows: [
              { start: '09:00', end: '12:00' },
              { start: '11:00', end: '14:00' },
            ],
          },
        ],
        'noOverlap',
      ],
      [
        'hora que no es múltiplo de 5',
        [{ dayOfWeek: 1, windows: [{ start: '09:03', end: '12:00' }] }],
        'multipleOf5Minutes',
      ],
      [
        'fin antes del inicio (cruza la medianoche)',
        [{ dayOfWeek: 5, windows: [{ start: '18:00', end: '01:00' }] }],
        'endAfterStart',
      ],
      [
        'día repetido',
        [
          { dayOfWeek: 1, windows: [] },
          { dayOfWeek: 1, windows: [] },
        ],
        'uniqueDayOfWeek',
      ],
    ])('RF-DIS-001 rechaza %s', async (_case, days, constraint) => {
      const s = await shopReady();
      const res = await s.client
        .put(`${SHOPS}/${s.owner.shopId}/business-hours`, { days }, s.owner.token)
        .expect(400);
      expect(res.body.details[0].constraints).toEqual([constraint]);
    });

    it('RF-DIS-001 rechaza formatos inválidos (24:00, día 7)', async () => {
      const s = await shopReady();
      await s.client
        .put(
          `${SHOPS}/${s.owner.shopId}/business-hours`,
          { days: [{ dayOfWeek: 1, windows: [{ start: '09:00', end: '24:00' }] }] },
          s.owner.token,
        )
        .expect(400);
      await s.client
        .put(
          `${SHOPS}/${s.owner.shopId}/business-hours`,
          { days: [{ dayOfWeek: 7, windows: [] }] },
          s.owner.token,
        )
        .expect(400);
    });

    it('RF-DIS-001 cambiar el horario informa cuántas reservas futuras quedan fuera (y se mantienen)', async () => {
      const s = await shopReady();
      await booking(s, lima(MONDAY, '12:00'));
      const res = await s.client
        .put(
          `${SHOPS}/${s.owner.shopId}/business-hours`,
          { days: [{ dayOfWeek: 1, windows: [{ start: '09:00', end: '11:00' }] }] },
          s.owner.token,
        )
        .expect(200);
      expect(res.body.bookingsOutsideSchedule).toBe(1);
      expect(
        await prisma.booking.count({
          where: { barbershopId: s.owner.shopId, status: 'CONFIRMED' },
        }),
      ).toBe(1);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barbershop.business_hours_changed', entityId: s.owner.shopId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.changes).toEqual({
        values: { businessHours: { from: '1:09:00-13:00 2:09:00-13:00', to: '1:09:00-11:00' } },
      });
    });

    it('autorización: sin sesión 401; un no miembro 404', async () => {
      const s = await shopReady();
      const body = { days: [] };
      await new AuthClient(app).put(`${SHOPS}/${s.owner.shopId}/business-hours`, body).expect(401);
      const other = await ownerWithShop(new AuthClient(app));
      await new AuthClient(app)
        .put(`${SHOPS}/${s.owner.shopId}/business-hours`, body, other.token)
        .expect(404);
    });
  });

  describe('RF-DIS-003 disponibilidad de una fecha', () => {
    it('RF-DIS-003 turnos de 30 min cada 15 de 09:00 a 12:30 con el barbero libre', async () => {
      const s = await shopReady();
      const res = await s.day(MONDAY).expect(200);
      expect(res.body.date).toBe(MONDAY);
      expect(res.body.timezone).toBe(LIMA);
      expect(res.body.slots).toHaveLength(15);
      expect(res.body.slots[0]).toEqual({
        startAt: new Date(lima(MONDAY, '09:00')).toISOString(),
        endAt: new Date(lima(MONDAY, '09:30')).toISOString(),
        barberIds: [s.barberId],
      });
    });

    it('RF-DIS-003 una reserva quita su turno; al cancelarla vuelve', async () => {
      const s = await shopReady();
      const b = await booking(s, lima(MONDAY, '10:00'));
      let starts = startsOf(await s.day(MONDAY).expect(200));
      expect(starts).not.toContain('09:45');
      expect(starts).not.toContain('10:00');
      expect(starts).not.toContain('10:15');
      expect(starts).toContain('10:30');

      await prisma.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
      starts = startsOf(await s.day(MONDAY).expect(200));
      expect(starts).toContain('10:00');
    });

    it('RF-DIS-003 PENDING_PAYMENT vigente bloquea; vencida no (aunque aún no esté EXPIRED)', async () => {
      const s = await shopReady();
      await booking(s, lima(MONDAY, '10:00'), {
        status: 'PENDING_PAYMENT',
        expiresAt: new Date(clock.current + 600_000),
      });
      await booking(s, lima(MONDAY, '11:00'), {
        status: 'PENDING_PAYMENT',
        expiresAt: new Date(clock.current - 1000),
      });
      const starts = startsOf(await s.day(MONDAY).expect(200));
      expect(starts).not.toContain('10:00');
      expect(starts).toContain('11:00');
    });

    it('"hoy", el horizonte y las fechas pasadas se evalúan en la zona de la barbería', async () => {
      const s = await shopReady();
      // Lunes 22:00 en Lima = martes 03:00 UTC.
      clock.current = Date.parse('2030-01-08T03:00:00Z');
      expect(new Date(clock.current).toISOString().slice(0, 10)).toBe(TUESDAY);

      await s.day(MONDAY).expect(200); // en Lima todavía es lunes: no es pasado
      const past = await s.day('2030-01-06').expect(400);
      expect(past.body).toMatchObject({
        code: 'DATE_OUT_OF_RANGE',
        message: 'La fecha ya pasó en el horario de la barbería.',
      });
      expect(past.body.details[0]).toEqual({
        today: MONDAY,
        lastBookableDate: '2030-02-06',
        timezone: LIMA,
      });

      // Horizonte de 30 días desde el lunes local (en UTC sería desde el martes).
      await s.day('2030-02-06').expect(200);
      const beyond = await s.day('2030-02-07').expect(400);
      expect(beyond.body.code).toBe('DATE_OUT_OF_RANGE');
    });

    it('RF-DIS-003 turnos de hoy: descarta los que ya empezaron', async () => {
      const s = await shopReady();
      clock.current = lima(MONDAY, '10:05');
      const starts = startsOf(await s.day(MONDAY).expect(200));
      expect(starts[0]).toBe('10:15');
    });

    it('RF-DIS-003 rechaza servicio ajeno, no disponible, barbero que no lo realiza y fecha mal formada', async () => {
      const s = await shopReady();
      const other = await shopReady();
      await new AuthClient(app)
        .get(`${SHOPS}/${s.owner.shopId}/availability?serviceId=${other.serviceId}&date=${MONDAY}`)
        .expect(404);
      await s.day(MONDAY, `&barberId=${other.barberId}`).expect(404);
      await s.day('07-01-2030').expect(400);
      await s.client
        .patch(
          `${SHOPS}/${s.owner.shopId}/services/${s.serviceId}`,
          { isAvailable: false },
          s.owner.token,
        )
        .expect(200);
      await s.day(MONDAY).expect(404);
    });

    it.each(['SUSPENDED', 'PENDING_REVIEW'] as const)(
      'una barbería %s responde 404 en disponibilidad',
      async (status) => {
        const s = await shopReady();
        await prisma.barbershop.update({ where: { id: s.owner.shopId }, data: { status } });
        await s.day(MONDAY).expect(404);
        await new AuthClient(app)
          .get(`${SHOPS}/${s.owner.shopId}/availability/now?serviceId=${s.serviceId}`)
          .expect(404);
        await new AuthClient(app).get(`${SHOPS}/${s.owner.shopId}/business-hours`).expect(404);
      },
    );

    it('una barbería cerrada temporalmente no ofrece turnos en ninguna fecha', async () => {
      const s = await shopReady();
      await s.client
        .patch(
          `${SHOPS}/${s.owner.shopId}/status`,
          {
            status: 'TEMPORARILY_CLOSED',
            expectedReopenAt: new Date(lima(MONDAY, '12:00')).toISOString(),
          },
          s.owner.token,
        )
        .expect(200);
      expect((await s.day(TUESDAY).expect(200)).body.slots).toEqual([]);
    });
  });

  describe('privacidad de las respuestas públicas', () => {
    it('solo turnos e ID de barberos libres: nunca motivos, tipos de bloqueo, reservas ni clientes', async () => {
      const s = await shopReady();
      const b = await booking(s, lima(MONDAY, '11:00'));
      await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/time-blocks`,
          {
            barberId: s.barberId,
            startAt: new Date(lima(MONDAY, '09:00')).toISOString(),
            endAt: new Date(lima(MONDAY, '10:00')).toISOString(),
            type: 'ABSENCE',
            reason: 'Cita médica privada',
          },
          s.owner.token,
        )
        .expect(201);

      const responses = await Promise.all([
        s.day(MONDAY).expect(200),
        new AuthClient(app)
          .get(`${SHOPS}/${s.owner.shopId}/availability/next?serviceId=${s.serviceId}`)
          .expect(200),
        new AuthClient(app)
          .get(`${SHOPS}/${s.owner.shopId}/availability/now?serviceId=${s.serviceId}`)
          .expect(200),
        new AuthClient(app).get(`${SHOPS}/${s.owner.shopId}/business-hours`).expect(200),
      ]);
      for (const res of responses) {
        const raw = JSON.stringify(res.body);
        expect(raw).not.toMatch(/Cita médica|ABSENCE|reason|type|clientId|bookingId|status/);
        expect(raw).not.toContain(b.id);
        expect(raw).not.toContain(s.owner.userId);
      }
      const day = responses[0].body as { slots: Record<string, unknown>[] };
      expect(Object.keys(day).sort()).toEqual(['date', 'slots', 'timezone']);
      for (const slot of day.slots)
        expect(Object.keys(slot).sort()).toEqual(['barberIds', 'endAt', 'startAt']);
    });
  });

  describe('RF-BRB-003 horario y bloqueos del barbero', () => {
    it('RF-BRB-003 horario propio limita sus turnos; vacío vuelve a heredar el de la barbería', async () => {
      const s = await shopReady();
      const path = `${SHOPS}/${s.owner.shopId}/barbers/${s.barberId}/schedule`;
      const res = await s.client
        .put(
          path,
          { days: [{ dayOfWeek: 1, windows: [{ start: '08:00', end: '10:00' }] }] },
          s.owner.token,
        )
        .expect(200);
      expect(res.body).toMatchObject({ inheritsBusinessHours: false, bookingsOutsideSchedule: 0 });
      // Solo cuenta la intersección con 09:00–13:00.
      let starts = startsOf(await s.day(MONDAY).expect(200));
      expect(starts).toEqual(['09:00', '09:15', '09:30']);

      await s.client.put(path, { days: [] }, s.owner.token).expect(200);
      starts = startsOf(await s.day(MONDAY).expect(200));
      expect(starts).toHaveLength(15);
      expect((await s.client.get(path, s.owner.token).expect(200)).body.inheritsBusinessHours).toBe(
        true,
      );
    });

    it('RF-BRB-003 un bloqueo quita turnos; al eliminarlo vuelven', async () => {
      const s = await shopReady();
      const block = await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/time-blocks`,
          {
            startAt: new Date(lima(MONDAY, '09:00')).toISOString(),
            endAt: new Date(lima(MONDAY, '12:00')).toISOString(),
            type: 'MANUAL',
          },
          s.owner.token,
        )
        .expect(201);
      let starts = startsOf(await s.day(MONDAY).expect(200));
      expect(starts).toEqual(['12:00', '12:15', '12:30']);
      await s.client
        .delete(`${SHOPS}/${s.owner.shopId}/time-blocks/${block.body.id}`, s.owner.token)
        .expect(204);
      starts = startsOf(await s.day(MONDAY).expect(200));
      expect(starts).toHaveLength(15);
    });

    it('RF-BRB-003 un bloqueo que choca con reservas activas se rechaza con 409', async () => {
      const s = await shopReady();
      await booking(s, lima(MONDAY, '10:00'));
      const body = {
        startAt: new Date(lima(MONDAY, '09:00')).toISOString(),
        endAt: new Date(lima(MONDAY, '11:00')).toISOString(),
        type: 'ABSENCE',
      };
      const own = await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/time-blocks`,
          { ...body, barberId: s.barberId },
          s.owner.token,
        )
        .expect(409);
      expect(own.body).toMatchObject({
        code: 'BLOCK_OVERLAPS_BOOKINGS',
        details: [{ affectedBookings: 1 }],
      });
      await s.client
        .post(`${SHOPS}/${s.owner.shopId}/time-blocks`, body, s.owner.token)
        .expect(409); // toda la barbería
    });

    it('RF-BRB-003 valida el bloqueo: fin posterior y múltiplos de 5 minutos', async () => {
      const s = await shopReady();
      const base = { type: 'MANUAL' };
      await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/time-blocks`,
          {
            ...base,
            startAt: new Date(lima(MONDAY, '10:00')).toISOString(),
            endAt: new Date(lima(MONDAY, '09:00')).toISOString(),
          },
          s.owner.token,
        )
        .expect(400);
      await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/time-blocks`,
          {
            ...base,
            startAt: new Date(lima(MONDAY, '10:03')).toISOString(),
            endAt: new Date(lima(MONDAY, '11:00')).toISOString(),
          },
          s.owner.token,
        )
        .expect(400);
    });

    it('RF-BRB-003 el barbero gestiona sus propios bloqueos, pero no el horario semanal ni bloqueos ajenos', async () => {
      const s = await shopReady();
      const other = await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/barbers`,
          { displayName: 'Luis', serviceIds: [s.serviceId] },
          s.owner.token,
        )
        .expect(201);
      // Vincular la cuenta del barbero por invitación.
      const barberClient = new AuthClient(app);
      const account = await barberClient.newUser();
      await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/barbers/${s.barberId}/invitations`,
          { email: account.email },
          s.owner.token,
        )
        .expect(202);
      const code = codeFrom(await waitForMail(app, account.email, 'barber-invitation'));
      const token = account.tokens.accessToken;
      const inv = await barberClient.get('/api/v1/me/barbershop-invitations', token).expect(200);
      await barberClient
        .post(`/api/v1/me/barbershop-invitations/${inv.body.items[0].id}/accept`, { code }, token)
        .expect(204);

      const block = {
        startAt: new Date(lima(TUESDAY, '09:00')).toISOString(),
        endAt: new Date(lima(TUESDAY, '10:00')).toISOString(),
        type: 'BREAK',
        reason: 'Trámite personal',
      };
      const mine = await barberClient
        .post(`${SHOPS}/${s.owner.shopId}/time-blocks`, { ...block, barberId: s.barberId }, token)
        .expect(201);
      await barberClient
        .post(
          `${SHOPS}/${s.owner.shopId}/time-blocks`,
          { ...block, barberId: other.body.id },
          token,
        )
        .expect(403);
      await barberClient.post(`${SHOPS}/${s.owner.shopId}/time-blocks`, block, token).expect(403); // toda la barbería
      await barberClient
        .put(`${SHOPS}/${s.owner.shopId}/barbers/${s.barberId}/schedule`, { days: [] }, token)
        .expect(403);
      await barberClient
        .get(`${SHOPS}/${s.owner.shopId}/barbers/${s.barberId}/schedule`, token)
        .expect(200);
      await barberClient
        .put(`${SHOPS}/${s.owner.shopId}/business-hours`, { days: [] }, token)
        .expect(404);

      // El motivo lo ven el propio barbero y los responsables.
      const asBarber = await barberClient
        .get(`${SHOPS}/${s.owner.shopId}/time-blocks`, token)
        .expect(200);
      expect(asBarber.body).toEqual([
        expect.objectContaining({ id: mine.body.id, reason: 'Trámite personal' }),
      ]);
      const ownerBlock = await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/time-blocks`,
          { ...block, barberId: other.body.id, reason: 'Vacaciones' },
          s.owner.token,
        )
        .expect(201);
      const asBarberAgain = await barberClient
        .get(`${SHOPS}/${s.owner.shopId}/time-blocks`, token)
        .expect(200);
      expect((asBarberAgain.body as { id: string }[]).map((b) => b.id)).not.toContain(
        ownerBlock.body.id,
      );
      const asOwner = await s.client
        .get(`${SHOPS}/${s.owner.shopId}/time-blocks`, s.owner.token)
        .expect(200);
      expect((asOwner.body as { reason: string }[]).map((b) => b.reason).sort()).toEqual([
        'Trámite personal',
        'Vacaciones',
      ]);
      await barberClient
        .delete(`${SHOPS}/${s.owner.shopId}/time-blocks/${ownerBlock.body.id}`, token)
        .expect(403);
      await barberClient
        .delete(`${SHOPS}/${s.owner.shopId}/time-blocks/${mine.body.id}`, token)
        .expect(204);
    });

    it('un usuario sin relación con la barbería no ve ni gestiona bloqueos', async () => {
      const s = await shopReady();
      const stranger = new AuthClient(app);
      const { tokens } = await stranger.newUser();
      await stranger.get(`${SHOPS}/${s.owner.shopId}/time-blocks`, tokens.accessToken).expect(404);
      await stranger
        .get(`${SHOPS}/${s.owner.shopId}/barbers/${s.barberId}/schedule`, tokens.accessToken)
        .expect(404);
    });
  });

  describe('RF-DIS-002 disponible ahora y RF-DIS-004 siguiente disponibilidad', () => {
    const now = (s: { owner: { shopId: string }; serviceId: string }) =>
      new AuthClient(app).get(
        `${SHOPS}/${s.owner.shopId}/availability/now?serviceId=${s.serviceId}`,
      );
    const next = (s: { owner: { shopId: string }; serviceId: string }) =>
      new AuthClient(app).get(
        `${SHOPS}/${s.owner.shopId}/availability/next?serviceId=${s.serviceId}`,
      );

    it('RF-DIS-002 disponible si hay un turno dentro de los próximos 30 minutos', async () => {
      const s = await shopReady();
      clock.current = lima(MONDAY, '10:05');
      const res = await now(s).expect(200);
      expect(res.body.available).toBe(true);
      expect(hhmm(res.body.slot.startAt)).toBe('10:15');

      clock.current = lima(MONDAY, '12:50'); // el último turno (12:30) ya empezó
      expect((await now(s).expect(200)).body).toEqual({ available: false, slot: null });

      clock.current = lima(MONDAY, '08:00'); // abre en 60 min: fuera de la ventana
      expect((await now(s).expect(200)).body.available).toBe(false);
    });

    it('RF-DIS-002 respeta la ventana configurada en app_settings', async () => {
      const s = await shopReady();
      await prisma.appSetting.create({
        data: { key: 'availability.now_window_minutes', value: 90 },
      });
      try {
        clock.current = lima(MONDAY, '08:00');
        expect((await now(s).expect(200)).body.available).toBe(true);
      } finally {
        await prisma.appSetting.delete({ where: { key: 'availability.now_window_minutes' } });
      }
    });

    it('RF-DIS-004 si hoy está lleno, ofrece el primer turno del día siguiente', async () => {
      const s = await shopReady();
      await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/time-blocks`,
          {
            barberId: s.barberId,
            startAt: new Date(lima(MONDAY, '09:00')).toISOString(),
            endAt: new Date(lima(MONDAY, '13:00')).toISOString(),
            type: 'ABSENCE',
          },
          s.owner.token,
        )
        .expect(201);
      const res = await next(s).expect(200);
      expect(res.body.slot.startAt).toBe(new Date(lima(TUESDAY, '09:00')).toISOString());
    });

    it('RF-DIS-004 sin turnos dentro del horizonte devuelve null', async () => {
      const s = await shopReady({ days: [] });
      expect((await next(s).expect(200)).body).toEqual({ slot: null });
    });

    it('RF-DIS-004 con un barbero concreto busca solo sus turnos', async () => {
      const s = await shopReady();
      const busy = await s.client
        .post(
          `${SHOPS}/${s.owner.shopId}/barbers`,
          { displayName: 'Ocupado', serviceIds: [s.serviceId] },
          s.owner.token,
        )
        .expect(201);
      await s.client
        .put(
          `${SHOPS}/${s.owner.shopId}/barbers/${busy.body.id}/schedule`,
          { days: [{ dayOfWeek: 2, windows: [{ start: '11:00', end: '12:00' }] }] },
          s.owner.token,
        )
        .expect(200);
      const res = await new AuthClient(app)
        .get(
          `${SHOPS}/${s.owner.shopId}/availability/next?serviceId=${s.serviceId}&barberId=${busy.body.id}`,
        )
        .expect(200);
      expect(res.body.slot).toEqual({
        startAt: new Date(lima(TUESDAY, '11:00')).toISOString(),
        endAt: new Date(lima(TUESDAY, '11:30')).toISOString(),
        barberIds: [busy.body.id],
      });
    });
  });

  describe('carga por lotes (preparada para la Fase 6)', () => {
    it('calcula "disponible ahora" de varias barberías en una sola llamada; ignora las inválidas', async () => {
      const a = await shopReady();
      const b = await shopReady({ days: [] });
      clock.current = lima(MONDAY, '10:05');
      const service = app.get(AvailabilityService);
      const result = await service.availableNowBatch([
        { barbershopId: a.owner.shopId, serviceId: a.serviceId },
        { barbershopId: b.owner.shopId, serviceId: b.serviceId },
        { barbershopId: a.owner.shopId, serviceId: b.serviceId }, // servicio de otra barbería
      ]);
      expect(result.get(`${a.owner.shopId}|${a.serviceId}|*`)?.start).toBe(lima(MONDAY, '10:15'));
      expect(result.get(`${b.owner.shopId}|${b.serviceId}|*`)).toBeNull();
      expect(result.has(`${a.owner.shopId}|${b.serviceId}|*`)).toBe(false);
    });
  });

  it('las consultas públicas de disponibilidad tienen límite de peticiones', async () => {
    const s = await shopReady();
    const visitor = new AuthClient(app);
    const path = `${SHOPS}/${s.owner.shopId}/availability?serviceId=${s.serviceId}&date=${MONDAY}`;
    for (let i = 0; i < 60; i++) await visitor.get(path).expect(200);
    expect((await visitor.get(path).expect(429)).body.code).toBe('TOO_MANY_REQUESTS');
  });
});
