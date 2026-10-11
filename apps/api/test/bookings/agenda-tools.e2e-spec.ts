import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { devBooking, DevToolError, parseOffset } from '../../src/scripts/dev-tools';
import { createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY } from '../support/bookings';

/** M7 de la app: canCancel, fecha de la agenda y dev:booking. */
describe('Agenda: canCancel, rango de fechas y dev:booking (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    kit = bookingKit(app, clock);
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
  });
  afterAll(() => app.close());

  /** Barbería con un barbero vinculado a una cuenta (para dev:booking). */
  async function shopWithLinkedBarber() {
    const shop = await kit.shopReady();
    const barber = await kit.verified();
    await prisma.barber.update({ where: { id: shop.barberId }, data: { userId: barber.userId } });
    return { shop, barber };
  }

  const agenda = (shop: Awaited<ReturnType<BookingKit['shopReady']>>, date = MONDAY) =>
    shop.owner.client.get(
      `${API}/barbershops/${shop.shopId}/agenda?date=${date}`,
      shop.owner.token,
    );

  it('canCancel: OWNER o MANAGER, reserva pendiente o confirmada que no empezó; nunca el barbero', async () => {
    const { shop, barber } = await shopWithLinkedBarber();
    const confirmed = await kit.confirmed(shop, lima(MONDAY, '12:00'));
    const pending = await kit.book(shop, lima(MONDAY, '13:00'));
    const actionsOf = (body: { items: { bookingId: string; actions: { canCancel: boolean } }[] }) =>
      Object.fromEntries(body.items.map((i) => [i.bookingId, i.actions.canCancel]));

    const asOwner = (await agenda(shop).expect(200)).body;
    expect(actionsOf(asOwner)).toEqual({ [confirmed.id]: true, [pending.id]: true });
    const asBarber = (
      await barber.client.get(`${API}/me/barber/agenda?date=${MONDAY}`, barber.token).expect(200)
    ).body;
    expect(actionsOf(asBarber)).toEqual({ [confirmed.id]: false, [pending.id]: false });

    // Cuando ya empezó, la confirmada deja de ser cancelable (igual que POST /cancel).
    clock.current = lima(MONDAY, '12:05');
    expect(actionsOf((await agenda(shop).expect(200)).body)[confirmed.id]).toBe(false);
    await shop.owner.client
      .post(`${API}/bookings/${confirmed.id}/cancel`, { reason: 'Prueba' }, shop.owner.token)
      .expect(409);
  });

  it('fecha: real, desde 90 días atrás hasta el horizonte de reservas (30 días)', async () => {
    const shop = await kit.shopReady();
    await agenda(shop, '2030-01-07').expect(200);
    await agenda(shop, '2029-10-09').expect(200); // hoy − 90
    await agenda(shop, '2030-02-06').expect(200); // hoy + 30
    const before = await agenda(shop, '2029-10-08').expect(400);
    expect(before.body).toMatchObject({
      code: 'DATE_OUT_OF_RANGE',
      details: [
        {
          today: '2030-01-07',
          firstDate: '2029-10-09',
          lastDate: '2030-02-06',
          timezone: 'America/Lima',
        },
      ],
    });
    expect((await agenda(shop, '2030-02-07').expect(400)).body.code).toBe('DATE_OUT_OF_RANGE');
    const invalid = await agenda(shop, '2030-02-30').expect(400);
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'date', constraints: ['isDate'] }],
    });
    await agenda(shop, '07-01-2030').expect(400);
  });

  describe('dev:booking', () => {
    it('crea reservas a horas relativas, también pasadas, y las confirma o marca atendidas', async () => {
      const { shop, barber } = await shopWithLinkedBarber();
      clock.current = lima(MONDAY, '12:00');
      const minus20 = await devBooking(app, {
        barberEmail: barber.email,
        clientEmail: (await kit.verified()).email,
        startOffsetMinutes: -20,
        confirm: true,
      });
      expect(minus20).toMatchObject({ status: 'CONFIRMED', barbershopId: shop.shopId });
      expect(minus20.startAt.getTime()).toBe(lima(MONDAY, '11:40'));

      const client = await kit.verified();
      const attended = await devBooking(app, {
        barberEmail: barber.email,
        clientEmail: client.email,
        startOffsetMinutes: -47 * 60,
        attended: true,
      });
      expect(attended.status).toBe('ATTENDED');
      const pending = await devBooking(app, {
        barberEmail: barber.email,
        clientEmail: client.email,
        startOffsetMinutes: 30,
      });
      expect(pending.status).toBe('PENDING_PAYMENT');

      // En la agenda de hoy: la de −20 min se puede marcar atendida; corregir la de −47 h, también.
      const today = (await agenda(shop).expect(200)).body;
      const item = today.items.find(
        (i: { bookingId: string }) => i.bookingId === minus20.bookingId,
      );
      expect(item.actions).toMatchObject({
        canMarkAttended: true,
        canMarkNoShow: true,
        canCancel: false,
      });
      await shop.owner.client
        .post(
          `${API}/bookings/${attended.bookingId}/attendance-correction`,
          { status: 'NO_SHOW', reason: 'Prueba de corrección' },
          shop.owner.token,
        )
        .expect(200);

      // Queda auditado y respeta la restricción contra reservas solapadas.
      expect(
        await prisma.auditLog.count({
          where: { action: 'dev.booking_created', entityId: minus20.bookingId },
        }),
      ).toBe(1);
      await expect(
        devBooking(app, {
          barberEmail: barber.email,
          clientEmail: client.email,
          startOffsetMinutes: -20,
        }),
      ).rejects.toThrow(/se cruza/);
    });

    it('errores claros: cuenta sin perfil de barbero, correo inexistente, desfase inválido', async () => {
      const someone = await kit.verified();
      await expect(
        devBooking(app, { barberEmail: someone.email, startOffsetMinutes: 0 }),
      ).rejects.toThrow(/perfil de barbero/);
      await expect(
        devBooking(app, { barberEmail: 'nadie@example.com', startOffsetMinutes: 0 }),
      ).rejects.toBeInstanceOf(DevToolError);
      expect(parseOffset('-20m')).toBe(-20);
      expect(parseOffset('+2h')).toBe(120);
      expect(parseOffset('-47h')).toBe(-2820);
      expect(parseOffset('15')).toBe(15);
      expect(() => parseOffset('ayer')).toThrow(DevToolError);
    });
  });
});
