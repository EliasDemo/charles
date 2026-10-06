import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DateTime } from 'luxon';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { FAKE_SIGNATURE_HEADER, FakeGateway } from '../../src/modules/payments/fake-gateway';
import { AuthClient, codeFrom, waitForMail } from './auth';
import { ownerWithShop } from './barbershops';

export const API = '/api/v1';
export const LIMA = 'America/Lima';
/** Lunes de referencia de las pruebas con reloj fijo. */
export const MONDAY = '2030-01-07';
export const HOUR = 3_600_000;

export const lima = (date: string, hhmm: string): number =>
  DateTime.fromISO(`${date}T${hhmm}`, { zone: LIMA }).toMillis();

export interface Person {
  client: AuthClient;
  token: string;
  userId: string;
  email: string;
}

export interface TestClock {
  current: number;
  now(): number;
}

/**
 * Atajos de datos de prueba para fases que parten de reservas ya existentes (Fases 11 y 12):
 * cliente verificado, barbería con horario y reserva pagada. Las fases que prueban esos flujos
 * (4, 5, 7, 8A) los recorren completos en sus propias pruebas.
 */
export function bookingKit(app: NestExpressApplication, clock: TestClock) {
  const prisma = app.get(PrismaService);

  async function verified(overrides: Record<string, unknown> = {}): Promise<Person> {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser(overrides);
    const code = codeFrom(await waitForMail(app, email, 'welcome-verification'));
    await client
      .post(`${API}/auth/email-verification/confirm`, { code }, tokens.accessToken)
      .expect(204);
    return { client, token: tokens.accessToken, userId: tokens.user.id, email };
  }

  /** Barbería con un servicio de 30 min, un barbero y horario 09:00–18:00 los días indicados. */
  async function shopReady(days: number[] = [1, 2, 3, 4, 5]) {
    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    const service = await client
      .post(
        `${API}/barbershops/${owner.shopId}/services`,
        { name: 'Corte', priceAmount: 2500, durationMinutes: 30, categoryKey: 'haircut' },
        owner.token,
      )
      .expect(201);
    const barber = await client
      .post(
        `${API}/barbershops/${owner.shopId}/barbers`,
        { displayName: 'Carlos', serviceIds: [service.body.id] },
        owner.token,
      )
      .expect(201);
    await client
      .put(
        `${API}/barbershops/${owner.shopId}/business-hours`,
        {
          days: days.map((dayOfWeek) => ({
            dayOfWeek,
            windows: [{ start: '09:00', end: '18:00' }],
          })),
        },
        owner.token,
      )
      .expect(200);
    return {
      owner: { ...owner, client },
      shopId: owner.shopId,
      serviceId: service.body.id as string,
      barberId: barber.body.id as string,
    };
  }
  type Shop = Awaited<ReturnType<typeof shopReady>>;

  /** Reserva PENDING_PAYMENT; el reloj debe estar antes del turno. */
  async function book(shop: Shop, startAtMs: number, who?: Person) {
    const person = who ?? (await verified());
    const res = await person.client
      .post(
        `${API}/bookings`,
        {
          barbershopId: shop.shopId,
          serviceId: shop.serviceId,
          startAt: new Date(startAtMs).toISOString(),
          barberId: shop.barberId,
        },
        person.token,
      )
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    return {
      id: res.body.id as string,
      paymentId: res.body.payment.paymentId as string,
      person,
    };
  }

  /** Reserva confirmada por el webhook de la pasarela simulada. */
  async function confirmed(shop: Shop, startAtMs: number, who?: Person) {
    const booking = await book(shop, startAtMs, who);
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

  /** Confirmada y marcada ATTENDED por el responsable a su hora (el reloj queda en el inicio). */
  async function attended(shop: Shop, startAtMs: number, who?: Person) {
    const booking = await confirmed(shop, startAtMs, who);
    clock.current = startAtMs;
    await shop.owner.client
      .post(`${API}/bookings/${booking.id}/attended`, {}, shop.owner.token)
      .expect(200);
    // El historial usa la hora de la base; se alinea con el reloj de la prueba.
    await prisma.bookingStatusHistory.updateMany({
      where: { bookingId: booking.id, toStatus: 'ATTENDED' },
      data: { createdAt: new Date(clock.current) },
    });
    return booking;
  }

  return { verified, shopReady, book, confirmed, attended };
}

export type BookingKit = ReturnType<typeof bookingKit>;
export type KitShop = Awaited<ReturnType<BookingKit['shopReady']>>;
