import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DateTime } from 'luxon';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, codeFrom, createAuthTestApp, waitForMail } from '../support/auth';
import { ownerWithShop } from '../support/barbershops';

/**
 * RF-RES-007 bajo carga: muchas rondas de dos clientes que piden a la vez el mismo turno con el
 * mismo barbero. Cada ronda debe dar exactamente un 201 y un 409 SLOT_NOT_AVAILABLE. Cualquier otra
 * respuesta se guarda completa (estado y cuerpo) para diagnosticarla.
 */
const API = '/api/v1';
const LIMA = 'America/Lima';
const ROUNDS = Number(process.env.RACE_ROUNDS ?? 200);
const FIRST_DAY = DateTime.fromISO('2030-01-07', { zone: LIMA });

/** Turnos de 30 min que no se solapan: 06:00–22:00 cada día de la semana (32 por día). */
function slot(index: number): string {
  const day = Math.floor(index / 32);
  const minutes = 6 * 60 + (index % 32) * 30;
  return FIRST_DAY.plus({ days: day, minutes }).toUTC().toISO()!;
}

describe(`RF-RES-007 carrera por un turno bajo carga (${ROUNDS} rondas)`, () => {
  let app: NestExpressApplication;
  const clock = {
    current: FIRST_DAY.toMillis(),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
  });
  afterAll(() => app.close());

  async function verifiedClient() {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    const code = codeFrom(await waitForMail(app, email, 'welcome-verification'));
    await client
      .post(`${API}/auth/email-verification/confirm`, { code }, tokens.accessToken)
      .expect(204);
    return { client, token: tokens.accessToken };
  }

  it('cada ronda: exactamente un 201 y un 409 SLOT_NOT_AVAILABLE', async () => {
    const ownerClient = new AuthClient(app);
    const owner = await ownerWithShop(ownerClient);
    const service = await ownerClient
      .post(
        `${API}/barbershops/${owner.shopId}/services`,
        { name: 'Corte', priceAmount: 2500, durationMinutes: 30, categoryKey: 'haircut' },
        owner.token,
      )
      .expect(201);
    const barber = await ownerClient
      .post(
        `${API}/barbershops/${owner.shopId}/barbers`,
        { displayName: 'Carlos', serviceIds: [service.body.id] },
        owner.token,
      )
      .expect(201);
    await ownerClient
      .put(
        `${API}/barbershops/${owner.shopId}/business-hours`,
        {
          days: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
            dayOfWeek,
            windows: [{ start: '06:00', end: '22:00' }],
          })),
        },
        owner.token,
      )
      .expect(200);

    const anomalies: unknown[] = [];
    const tally: Record<string, number> = {};
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await Promise.all([verifiedClient(), verifiedClient()]);
      const startAt = slot(round);
      const book = (who: { client: AuthClient; token: string }) =>
        who.client
          .post(
            `${API}/bookings`,
            {
              barbershopId: owner.shopId,
              serviceId: service.body.id,
              startAt,
              barberId: barber.body.id,
            },
            who.token,
          )
          .set('Idempotency-Key', randomUUID());
      const responses = await Promise.all([book(a), book(b)]);
      const statuses = responses.map((r) => r.status).sort();
      const key = statuses.join('+');
      tally[key] = (tally[key] ?? 0) + 1;
      const ok =
        statuses[0] === 201 &&
        statuses[1] === 409 &&
        responses.find((r) => r.status === 409)?.body.code === 'SLOT_NOT_AVAILABLE';
      if (!ok) {
        anomalies.push({
          round,
          startAt,
          responses: responses.map((r) => ({ status: r.status, body: r.body })),
        });
      }
    }

    const active = await app.get(PrismaService).booking.groupBy({
      by: ['startAt'],
      where: { barbershopId: owner.shopId, status: 'PENDING_PAYMENT' },
      _count: { _all: true },
    });
    const doubleBooked = active.filter((g) => g._count._all > 1);
    console.warn(
      JSON.stringify(
        {
          rounds: ROUNDS,
          poolMax: process.env.DATABASE_POOL_MAX ?? 'default',
          tally,
          anomalies,
          doubleBooked: doubleBooked.length,
        },
        null,
        2,
      ),
    );
    expect(doubleBooked).toEqual([]);
    expect(anomalies).toEqual([]);
  });

  /**
   * Escenario de bloqueo mutuo: dos barberos, dos PENDING_PAYMENT vencidas que se solapan con el
   * turno (una por barbero) y dos clientes que piden "cualquier barbero" a la vez. Ambas
   * peticiones vencen las mismas reservas dentro de su transacción. Deben salir las dos (una por
   * barbero), sin 500.
   */
  it('"cualquier barbero" vence las mismas reservas a la vez: sin bloqueo mutuo', async () => {
    const rounds = Number(process.env.RACE_EXPIRE_ROUNDS ?? 100);
    const ownerClient = new AuthClient(app);
    const owner = await ownerWithShop(ownerClient);
    const service = await ownerClient
      .post(
        `${API}/barbershops/${owner.shopId}/services`,
        { name: 'Corte', priceAmount: 2500, durationMinutes: 30, categoryKey: 'haircut' },
        owner.token,
      )
      .expect(201);
    for (const displayName of ['Ana', 'Beto']) {
      await ownerClient
        .post(
          `${API}/barbershops/${owner.shopId}/barbers`,
          { displayName, serviceIds: [service.body.id] },
          owner.token,
        )
        .expect(201);
    }
    await ownerClient
      .put(
        `${API}/barbershops/${owner.shopId}/business-hours`,
        {
          days: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
            dayOfWeek,
            windows: [{ start: '06:00', end: '22:00' }],
          })),
        },
        owner.token,
      )
      .expect(200);
    const anomalies: unknown[] = [];
    const tally: Record<string, number> = {};
    const book = (who: { client: AuthClient; token: string }, startAt: string) =>
      who.client
        .post(
          `${API}/bookings`,
          { barbershopId: owner.shopId, serviceId: service.body.id, startAt },
          who.token,
        )
        .set('Idempotency-Key', randomUUID());
    for (let round = 0; round < rounds; round++) {
      clock.current = FIRST_DAY.toMillis();
      const startAt = slot(round);
      // Dos reservas pendientes (una por barbero) que se dejan vencer.
      const [x, y] = await Promise.all([verifiedClient(), verifiedClient()]);
      await book(x, startAt).expect(201);
      await book(y, startAt).expect(201);
      clock.current = FIRST_DAY.toMillis() + 11 * 60_000;
      const [a, b] = await Promise.all([verifiedClient(), verifiedClient()]);
      const responses = await Promise.all([book(a, startAt), book(b, startAt)]);
      const key = responses
        .map((r) => r.status)
        .sort()
        .join('+');
      tally[key] = (tally[key] ?? 0) + 1;
      if (key !== '201+201') {
        anomalies.push({
          round,
          responses: responses.map((r) => ({ status: r.status, body: r.body })),
        });
      }
    }
    console.warn(JSON.stringify({ scenario: 'expire-race', rounds, tally, anomalies }, null, 2));
    expect(anomalies).toEqual([]);
  });
});
