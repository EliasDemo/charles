import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY } from '../support/bookings';

/**
 * Toda respuesta con horas de una barbería trae su zona horaria (para mostrarlas en su zona y no
 * en la del teléfono). Se usa una barbería en Bogotá: el mismo desfase que Lima, otra zona.
 */
describe('Zona horaria en las respuestas con horas de una barbería (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };
  const BOGOTA = 'America/Bogota';

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    kit = bookingKit(app, clock);
  });
  afterAll(() => app.close());

  it('reserva (cliente y barbería), disponibilidad, horario del barbero, bloqueos y vista de soporte', async () => {
    const shop = await kit.shopReady();
    await prisma.barbershop.update({ where: { id: shop.shopId }, data: { timezone: BOGOTA } });
    const owner = shop.owner;
    const booking = await kit.book(shop, lima(MONDAY, '12:00'));

    // Reserva: creada, consultada por el cliente y por la barbería, y en las listas.
    const mine = await booking.person.client
      .get(`${API}/bookings/${booking.id}`, booking.person.token)
      .expect(200);
    expect(mine.body.barbershop).toEqual({
      id: shop.shopId,
      name: 'Barbería E2E',
      timezone: BOGOTA,
    });
    const list = await booking.person.client
      .get(`${API}/me/bookings`, booking.person.token)
      .expect(200);
    expect(list.body.items[0].barbershop.timezone).toBe(BOGOTA);
    const staff = await owner.client.get(`${API}/bookings/${booking.id}`, owner.token).expect(200);
    expect(staff.body.barbershop.timezone).toBe(BOGOTA);

    // Disponibilidad pública.
    const query = `serviceId=${shop.serviceId}`;
    const now = await owner.client
      .get(`${API}/barbershops/${shop.shopId}/availability/now?${query}`)
      .expect(200);
    expect(now.body.timezone).toBe(BOGOTA);
    const next = await owner.client
      .get(`${API}/barbershops/${shop.shopId}/availability/next?${query}`)
      .expect(200);
    expect(next.body.timezone).toBe(BOGOTA);

    // Horario del barbero y bloqueos (gestión).
    const schedule = await owner.client
      .get(`${API}/barbershops/${shop.shopId}/barbers/${shop.barberId}/schedule`, owner.token)
      .expect(200);
    expect(schedule.body.timezone).toBe(BOGOTA);
    const block = await owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/time-blocks`,
        {
          barberId: shop.barberId,
          startAt: new Date(lima(MONDAY, '16:00')).toISOString(),
          endAt: new Date(lima(MONDAY, '17:00')).toISOString(),
          type: 'BREAK',
        },
        owner.token,
      )
      .expect(201);
    expect(block.body.timezone).toBe(BOGOTA);
    const blocks = await owner.client
      .get(`${API}/barbershops/${shop.shopId}/time-blocks`, owner.token)
      .expect(200);
    const items = (Array.isArray(blocks.body) ? blocks.body : blocks.body.items) as {
      timezone: string;
    }[];
    expect(items.every((b) => b.timezone === BOGOTA)).toBe(true);

    // Vista de soporte.
    const agent = await kit.verified();
    await prisma.userRole.create({ data: { userId: agent.userId, role: 'SUPPORT' } });
    const admin = await agent.client
      .get(`${API}/admin/bookings/${booking.id}`, agent.token)
      .expect(200);
    expect(admin.body.barbershop).toEqual({
      id: shop.shopId,
      name: 'Barbería E2E',
      timezone: BOGOTA,
    });
  });
});
