import type { NestExpressApplication } from '@nestjs/platform-express';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY } from '../support/bookings';

/** Lista de espera: anotarse, límites, salir y aviso cuando se libera un turno. */
describe('Lista de espera (e2e)', () => {
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
  afterAll(() => app.close());

  async function deliver(): Promise<void> {
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
    await app.get(NotificationsService).deliverDue();
  }

  it('anotarse (idempotente), validar el día y la franja, listar y salir', async () => {
    const shop = await kit.shopReady();
    const ana = await kit.verified();
    const base = `${API}/barbershops/${shop.shopId}/waitlist`;
    const body = { serviceId: shop.serviceId, date: MONDAY, fromMinute: 540, toMinute: 720 };
    const first = await ana.client.post(base, body, ana.token).expect(201);
    expect(first.body).toMatchObject({
      status: 'ACTIVE',
      date: MONDAY,
      serviceName: 'Corte',
      barberId: null,
    });
    const again = await ana.client.post(base, body, ana.token).expect(201);
    expect(again.body.id).toBe(first.body.id);

    await ana.client.post(base, { ...body, date: '2029-01-01' }, ana.token).expect(400);
    await ana.client.post(base, { ...body, date: '2031-12-31' }, ana.token).expect(400);
    await ana.client.post(base, { ...body, fromMinute: 700, toMinute: 600 }, ana.token).expect(400);
    await ana.client
      .post(base, { ...body, serviceId: '00000000-0000-7000-8000-000000000000' }, ana.token)
      .expect(400);
    await ana.client
      .post(base, { ...body, barberId: '00000000-0000-7000-8000-000000000000' }, ana.token)
      .expect(400);

    const mine = await ana.client.get(`${API}/me/waitlist`, ana.token).expect(200);
    expect(mine.body.map((e: { id: string }) => e.id)).toEqual([first.body.id]);
    await ana.client.delete(`${API}/me/waitlist/${first.body.id}`, ana.token).expect(204);
    await ana.client.delete(`${API}/me/waitlist/${first.body.id}`, ana.token).expect(404);
    expect((await ana.client.get(`${API}/me/waitlist`, ana.token).expect(200)).body).toEqual([]);
  });

  it('como máximo 5 listas activas a la vez', async () => {
    const luis = await kit.verified();
    const shops = await Promise.all([1, 2, 3, 4, 5, 6].map(() => kit.shopReady()));
    for (const s of shops.slice(0, 5)) {
      await luis.client
        .post(
          `${API}/barbershops/${s.shopId}/waitlist`,
          { serviceId: s.serviceId, date: MONDAY },
          luis.token,
        )
        .expect(201);
    }
    const full = await luis.client
      .post(
        `${API}/barbershops/${shops[5]!.shopId}/waitlist`,
        { serviceId: shops[5]!.serviceId, date: MONDAY },
        luis.token,
      )
      .expect(409);
    expect(full.body.code).toBe('CONFLICT');
  });

  it('al cancelarse una reserva, avisa a quien espera esa franja (y no a quien espera otra)', async () => {
    const shop = await kit.shopReady();
    const booked = await kit.confirmed(shop, lima(MONDAY, '10:00'));
    const waiting = await kit.verified();
    const other = await kit.verified();
    const base = `${API}/barbershops/${shop.shopId}/waitlist`;
    const mine = await waiting.client
      .post(
        base,
        { serviceId: shop.serviceId, date: MONDAY, fromMinute: 540, toMinute: 720 },
        waiting.token,
      )
      .expect(201);
    const afternoon = await other.client
      .post(
        base,
        { serviceId: shop.serviceId, date: MONDAY, fromMinute: 840, toMinute: 1080 },
        other.token,
      )
      .expect(201);

    await booked.person.client
      .post(`${API}/bookings/${booked.id}/cancel`, {}, booked.person.token)
      .expect(200);
    await deliver();

    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: mine.body.id } });
    expect(after.status).toBe('NOTIFIED');
    expect(
      (await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: afternoon.body.id } })).status,
    ).toBe('ACTIVE');
    const notice = await prisma.notification.findFirst({
      where: { userId: waiting.userId, type: 'WAITLIST_SLOT_FREED', channel: 'IN_APP' },
    });
    expect(notice?.body).toContain('Corte');
    const listed = await waiting.client.get(`${API}/me/waitlist`, waiting.token).expect(200);
    expect(listed.body[0]).toMatchObject({ status: 'NOTIFIED' });
  });
});
