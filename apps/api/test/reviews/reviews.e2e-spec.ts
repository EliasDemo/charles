import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DateTime } from 'luxon';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { FAKE_SIGNATURE_HEADER, FakeGateway } from '../../src/modules/payments/fake-gateway';
import { ReviewModerationService } from '../../src/modules/reviews/review-moderation.service';
import { RatingsVerifier } from '../../src/modules/reviews/review-ratings';
import { REVIEW_RATE_LIMIT } from '../../src/modules/reviews/review-rate-limit';
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Person {
  client: AuthClient;
  token: string;
  userId: string;
  username: string;
}

describe('RF-FAV-001…003, RF-VAL-001…003 Favoritos y valoraciones — Fase 11 (e2e)', () => {
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
    REVIEW_RATE_LIMIT.set(1000);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => app.close());

  async function verified(fullName?: string): Promise<Person> {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser(fullName ? { fullName } : {});
    const code = codeFrom(await waitForMail(app, email, 'welcome-verification'));
    await client
      .post(`${API}/auth/email-verification/confirm`, { code }, tokens.accessToken)
      .expect(204);
    return {
      client,
      token: tokens.accessToken,
      userId: tokens.user.id,
      username: tokens.user.username,
    };
  }

  /** Barbería con dos barberos, horario lunes 09:00–18:00. */
  async function shopReady() {
    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    const service = await client
      .post(
        `${SHOPS}/${owner.shopId}/services`,
        { name: 'Corte clásico', priceAmount: 2500, durationMinutes: 30, categoryKey: 'haircut' },
        owner.token,
      )
      .expect(201);
    const barbers: string[] = [];
    for (const displayName of ['Carlos', 'Luis']) {
      const barber = await client
        .post(
          `${SHOPS}/${owner.shopId}/barbers`,
          { displayName, serviceIds: [service.body.id] },
          owner.token,
        )
        .expect(201);
      barbers.push(barber.body.id as string);
    }
    await client
      .put(
        `${SHOPS}/${owner.shopId}/business-hours`,
        { days: [{ dayOfWeek: 1, windows: [{ start: '09:00', end: '18:00' }] }] },
        owner.token,
      )
      .expect(200);
    return {
      owner: { ...owner, client },
      shopId: owner.shopId,
      serviceId: service.body.id as string,
      barberIds: barbers as [string, string],
    };
  }
  type Shop = Awaited<ReturnType<typeof shopReady>>;

  /** Reserva pagada y marcada ATTENDED por el responsable a su hora (el reloj queda ahí). */
  async function attendedBooking(shop: Shop, hhmm: string, who?: Person, barber = 0) {
    const person = who ?? (await verified());
    clock.current = lima(MONDAY, '08:00');
    const res = await person.client
      .post(
        `${API}/bookings`,
        {
          barbershopId: shop.shopId,
          serviceId: shop.serviceId,
          startAt: at(hhmm),
          barberId: shop.barberIds[barber],
        },
        person.token,
      )
      .set('Idempotency-Key', randomUUID())
      .expect(201);
    const { rawBody, signature } = app
      .get(FakeGateway)
      .settlePayment(res.body.payment.paymentId as string, 'SUCCEEDED');
    const sender = new AuthClient(app);
    await sender.http
      .post(`${API}/payments/webhooks/fake`)
      .set('X-Forwarded-For', sender.ip)
      .set('Content-Type', 'application/json')
      .set(FAKE_SIGNATURE_HEADER, signature)
      .send(rawBody)
      .expect(200);
    clock.current = lima(MONDAY, hhmm);
    const id = res.body.id as string;
    await shop.owner.client
      .post(`${API}/bookings/${id}/attended`, {}, shop.owner.token)
      .expect(200);
    // El historial usa la hora de la base; se alinea con el reloj de la prueba.
    await prisma.bookingStatusHistory.updateMany({
      where: { bookingId: id, toStatus: 'ATTENDED' },
      data: { createdAt: new Date(clock.current) },
    });
    return { id, person };
  }

  const review = (who: Person, bookingId: string, body: Record<string, unknown>) =>
    who.client.post(`${API}/bookings/${bookingId}/review`, body, who.token);
  const report = (who: Person, reviewId: string, body: Record<string, unknown>) =>
    who.client.post(`${API}/reviews/${reviewId}/reports`, body, who.token);
  const ratingOf = async (shopId: string, barberId: string) => {
    const shop = await prisma.barbershop.findUniqueOrThrow({ where: { id: shopId } });
    const barber = await prisma.barber.findUniqueOrThrow({ where: { id: barberId } });
    return {
      shop: [Number(shop.ratingAvg), shop.ratingCount],
      barber: [Number(barber.ratingAvg), barber.ratingCount],
    };
  };
  const publicList = (shopId: string, query = '') =>
    new AuthClient(app).get(`${SHOPS}/${shopId}/reviews${query}`).expect(200);
  const relayAll = async () => {
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { availableAt: new Date(0) },
    });
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
  };

  // ───────────── Favoritos ─────────────

  describe('favoritos', () => {
    it('RF-FAV-001/002/003 marcar, listar y desmarcar son idempotentes', async () => {
      const shop = await shopReady();
      const other = await shopReady();
      const me = await verified();
      await me.client.put(`${API}/me/favorites/${shop.shopId}`, {}, me.token).expect(204);
      await me.client.put(`${API}/me/favorites/${shop.shopId}`, {}, me.token).expect(204);
      await me.client.put(`${API}/me/favorites/${other.shopId}`, {}, me.token).expect(204);
      const list = await me.client.get(`${API}/me/favorites`, me.token).expect(200);
      expect(list.body.items.map((f: { barbershopId: string }) => f.barbershopId)).toEqual([
        other.shopId,
        shop.shopId,
      ]);
      expect(list.body.items[0]).toEqual(
        expect.objectContaining({
          name: 'Barbería E2E',
          status: 'OPEN',
          rating: { average: 0, count: 0 },
        }),
      );
      const page = await me.client.get(`${API}/me/favorites?limit=1`, me.token).expect(200);
      expect(page.body.items).toHaveLength(1);
      const next = await me.client
        .get(`${API}/me/favorites?limit=1&cursor=${page.body.nextCursor}`, me.token)
        .expect(200);
      expect(next.body.items[0].barbershopId).toBe(shop.shopId);
      expect(next.body.nextCursor).toBeNull();

      await me.client.delete(`${API}/me/favorites/${shop.shopId}`, me.token).expect(204);
      await me.client.delete(`${API}/me/favorites/${shop.shopId}`, me.token).expect(204);
      const after = await me.client.get(`${API}/me/favorites`, me.token).expect(200);
      expect(after.body.items).toHaveLength(1);
      // Cada cuenta ve solo los suyos.
      const someone = await verified();
      const theirs = await someone.client.get(`${API}/me/favorites`, someone.token).expect(200);
      expect(theirs.body.items).toEqual([]);
    });

    it('sin sesión: 401; barbería inexistente o no pública: 404', async () => {
      const shop = await shopReady();
      await new AuthClient(app).put(`${API}/me/favorites/${shop.shopId}`, {}).expect(401);
      await new AuthClient(app).get(`${API}/me/favorites`).expect(401);
      const me = await verified();
      await me.client.put(`${API}/me/favorites/${randomUUID()}`, {}, me.token).expect(404);
      await prisma.barbershop.update({ where: { id: shop.shopId }, data: { status: 'SUSPENDED' } });
      await me.client.put(`${API}/me/favorites/${shop.shopId}`, {}, me.token).expect(404);
    });

    it('una barbería suspendida desaparece de la lista y vuelve al reactivarse', async () => {
      const shop = await shopReady();
      const me = await verified();
      await me.client.put(`${API}/me/favorites/${shop.shopId}`, {}, me.token).expect(204);
      await prisma.barbershop.update({ where: { id: shop.shopId }, data: { status: 'SUSPENDED' } });
      expect((await me.client.get(`${API}/me/favorites`, me.token)).body.items).toEqual([]);
      await prisma.barbershop.update({ where: { id: shop.shopId }, data: { status: 'OPEN' } });
      expect((await me.client.get(`${API}/me/favorites`, me.token)).body.items).toHaveLength(1);
    });
  });

  // ───────────── Valorar ─────────────

  describe('RF-VAL-001 valorar', () => {
    it('RF-VAL-001 el cliente valora su reserva atendida; promedios de barbería y barbero', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00', await verified('Ana María Rodríguez'));
      const res = await review(a.person, a.id, {
        rating: 5,
        comment: '  Muy   buen corte  ',
      }).expect(201);
      expect(res.body).toEqual(
        expect.objectContaining({
          rating: 5,
          comment: 'Muy buen corte',
          // En público se ve el usuario, nunca el nombre real.
          authorName: a.person.username,
          serviceName: 'Corte clásico',
          barber: { id: shop.barberIds[0], displayName: 'Carlos' },
          bookingId: a.id,
          barbershop: { id: shop.shopId, name: 'Barbería E2E' },
          status: 'VISIBLE',
          canEdit: true,
          editedAt: null,
          response: null,
        }),
      );
      const b = await attendedBooking(shop, '11:00');
      await review(b.person, b.id, { rating: 2 }).expect(201);
      expect(await ratingOf(shop.shopId, shop.barberIds[0])).toEqual({
        shop: [3.5, 2],
        barber: [3.5, 2],
      });
      // Se expone en la ficha pública del barbero y de la barbería.
      const barbers = await new AuthClient(app).get(`${SHOPS}/${shop.shopId}/barbers`).expect(200);
      expect(barbers.body.items[0].rating).toEqual({ average: 3.5, count: 2 });
      const detail = await new AuthClient(app).get(`${SHOPS}/${shop.shopId}`).expect(200);
      expect(detail.body.rating).toEqual({ average: 3.5, count: 2 });
    });

    it('solo reservas ATTENDED propias, una vez y dentro del plazo de 14 días', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      // Ajena: 404 (no revela la reserva).
      await review(await verified(), a.id, { rating: 4 }).expect(404);
      await review(a.person, randomUUID(), { rating: 4 }).expect(404);
      // Validación.
      for (const body of [
        { rating: 0 },
        { rating: 6 },
        { rating: 4.5 },
        { rating: 4, comment: 'ab' },
      ]) {
        await review(a.person, a.id, body).expect(400);
      }
      await review(a.person, a.id, { rating: 4, comment: 'x'.repeat(501) }).expect(400);
      // Fuera de plazo (14 días inclusivos).
      clock.current = lima(MONDAY, '10:00') + 14 * DAY + 1;
      expect((await review(a.person, a.id, { rating: 4 }).expect(409)).body.code).toBe(
        'REVIEW_NOT_ALLOWED',
      );
      clock.current = lima(MONDAY, '10:00') + 14 * DAY;
      await review(a.person, a.id, { rating: 4 }).expect(201);
      expect((await review(a.person, a.id, { rating: 3 }).expect(409)).body.code).toBe(
        'REVIEW_ALREADY_EXISTS',
      );
    });

    it('una reserva no atendida (confirmada o inasistencia) no se valora', async () => {
      const shop = await shopReady();
      const me = await verified();
      clock.current = lima(MONDAY, '08:00');
      const res = await me.client
        .post(
          `${API}/bookings`,
          {
            barbershopId: shop.shopId,
            serviceId: shop.serviceId,
            startAt: at('12:00'),
            barberId: shop.barberIds[0],
          },
          me.token,
        )
        .set('Idempotency-Key', randomUUID())
        .expect(201);
      expect((await review(me, res.body.id, { rating: 5 }).expect(409)).body.code).toBe(
        'REVIEW_NOT_ALLOWED',
      );
    });

    it('dos valoraciones simultáneas de la misma reserva: una sola gana', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) => review(a.person, a.id, { rating: (i % 5) + 1 })),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      expect(await prisma.review.count({ where: { bookingId: a.id } })).toBe(1);
      expect((await ratingOf(shop.shopId, shop.barberIds[0])).shop[1]).toBe(1);
    });

    it('valoraciones simultáneas de reservas distintas: el promedio las cuenta todas', async () => {
      const shop = await shopReady();
      const bookings = [];
      for (const hhmm of ['10:00', '10:30', '11:00', '11:30', '12:00']) {
        bookings.push(await attendedBooking(shop, hhmm));
      }
      const ratings = [5, 4, 3, 2, 1];
      await Promise.all(
        bookings.map((b, i) => review(b.person, b.id, { rating: ratings[i] }).expect(201)),
      );
      expect(await ratingOf(shop.shopId, shop.barberIds[0])).toEqual({
        shop: [3, 5],
        barber: [3, 5],
      });
    });

    it('la base rechaza puntuaciones fuera de 1–5 aunque no pasen por la API', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const error = await prisma.review
        .create({
          data: {
            bookingId: a.id,
            clientId: a.person.userId,
            barbershopId: shop.shopId,
            barberId: shop.barberIds[0],
            rating: 6,
          },
        })
        .catch((e: unknown) => e);
      expect(describeError(error)).toContain('reviews_rating_check');
    });
  });

  describe('RF-VAL-001 editar y retirar', () => {
    it('se edita una sola vez dentro del plazo, sin cambiar la fecha original', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const created = await review(a.person, a.id, { rating: 2, comment: 'Regular' }).expect(201);
      const reviewId = created.body.id as string;
      await a.person.client.patch(`${API}/reviews/${reviewId}`, {}, a.person.token).expect(400);
      clock.current += DAY;
      const edited = await a.person.client
        .patch(`${API}/reviews/${reviewId}`, { rating: 4, comment: null }, a.person.token)
        .expect(200);
      expect(edited.body).toEqual(
        expect.objectContaining({ rating: 4, comment: null, canEdit: false }),
      );
      expect(edited.body.createdAt).toBe(created.body.createdAt);
      expect(edited.body.editedAt).toBe(new Date(clock.current).toISOString());
      expect((await ratingOf(shop.shopId, shop.barberIds[0])).shop).toEqual([4, 1]);
      expect(
        (
          await a.person.client
            .patch(`${API}/reviews/${reviewId}`, { rating: 5 }, a.person.token)
            .expect(409)
        ).body.code,
      ).toBe('REVIEW_EDIT_NOT_ALLOWED');
      // Otro usuario no la edita ni la retira.
      const other = await verified();
      await other.client
        .patch(`${API}/reviews/${reviewId}`, { rating: 1 }, other.token)
        .expect(404);
      await other.client.delete(`${API}/reviews/${reviewId}`, other.token).expect(404);
    });

    it('fuera de plazo no se edita, pero se puede retirar; el promedio se recalcula', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const b = await attendedBooking(shop, '11:00');
      const ra = await review(a.person, a.id, { rating: 5 }).expect(201);
      await review(b.person, b.id, { rating: 1 }).expect(201);
      clock.current = lima(MONDAY, '10:00') + 15 * DAY;
      await a.person.client
        .patch(`${API}/reviews/${ra.body.id}`, { rating: 4 }, a.person.token)
        .expect(409);
      await a.person.client.delete(`${API}/reviews/${ra.body.id}`, a.person.token).expect(204);
      await a.person.client.delete(`${API}/reviews/${ra.body.id}`, a.person.token).expect(404);
      expect(await ratingOf(shop.shopId, shop.barberIds[0])).toEqual({
        shop: [1, 1],
        barber: [1, 1],
      });
      const mine = await a.person.client.get(`${API}/me/reviews`, a.person.token).expect(200);
      expect(mine.body.items).toEqual([]);
      // Retirada no se puede volver a crear.
      clock.current = lima(MONDAY, '10:00') + DAY;
      await review(a.person, a.id, { rating: 3 }).expect(409);
    });
  });

  // ───────────── Público ─────────────

  describe('RF-VAL-002 listado público', () => {
    it('público, las más recientes primero, con filtros y sin datos de contacto', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00', await verified('Ana Rodríguez'), 0);
      const b = await attendedBooking(shop, '11:00', await verified('Beto Pérez'), 1);
      await review(a.person, a.id, { rating: 5, comment: 'Excelente' }).expect(201);
      await review(b.person, b.id, { rating: 3 }).expect(201);

      const all = await publicList(shop.shopId);
      expect(all.body.items.map((r: { authorName: string }) => r.authorName)).toEqual([
        b.person.username,
        a.person.username,
      ]);
      const body = JSON.stringify(all.body);
      expect(body).not.toMatch(/Rodríguez|Pérez|email|phone|clientId|status/);
      expect(Object.keys(all.body.items[0]).sort()).toEqual(
        [
          'id',
          'rating',
          'comment',
          'authorName',
          'serviceName',
          'barber',
          'createdAt',
          'editedAt',
          'response',
        ].sort(),
      );
      const byBarber = await publicList(shop.shopId, `?barberId=${shop.barberIds[0]}`);
      expect(byBarber.body.items).toHaveLength(1);
      const byRating = await publicList(shop.shopId, '?rating=3');
      expect(byRating.body.items.map((r: { authorName: string }) => r.authorName)).toEqual([
        b.person.username,
      ]);
      const page = await publicList(shop.shopId, '?limit=1');
      const next = await publicList(shop.shopId, `?limit=1&cursor=${page.body.nextCursor}`);
      expect(next.body.items[0].authorName).toBe(a.person.username);
      expect(next.body.nextCursor).toBeNull();
    });

    it('barbería no pública: 404', async () => {
      const shop = await shopReady();
      await prisma.barbershop.update({ where: { id: shop.shopId }, data: { status: 'SUSPENDED' } });
      await new AuthClient(app).get(`${SHOPS}/${shop.shopId}/reviews`).expect(404);
      await new AuthClient(app).get(`${SHOPS}/${randomUUID()}/reviews`).expect(404);
    });
  });

  // ───────────── Respuesta ─────────────

  describe('RF-VAL-002 respuesta de la barbería', () => {
    it('OWNER o MANAGER responde una vez y puede editar; queda auditada', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const r = await review(a.person, a.id, { rating: 3 }).expect(201);
      const reviewId = r.body.id as string;

      // Ni el cliente, ni otra barbería, ni sin sesión.
      await a.person.client
        .put(`${API}/reviews/${reviewId}/response`, { text: 'Hola' }, a.person.token)
        .expect(404);
      const stranger = await ownerWithShop(new AuthClient(app));
      await new AuthClient(app)
        .put(`${API}/reviews/${reviewId}/response`, { text: 'Hola' }, stranger.token)
        .expect(404);
      await new AuthClient(app)
        .put(`${API}/reviews/${reviewId}/response`, { text: 'Hola' })
        .expect(401);
      await shop.owner.client
        .put(`${API}/reviews/${reviewId}/response`, { text: '   ' }, shop.owner.token)
        .expect(400);

      const first = await shop.owner.client
        .put(
          `${API}/reviews/${reviewId}/response`,
          { text: ' Gracias por venir ' },
          shop.owner.token,
        )
        .expect(200);
      expect(first.body.response).toEqual({
        text: 'Gracias por venir',
        respondedAt: expect.any(String),
      });
      await shop.owner.client
        .put(`${API}/reviews/${reviewId}/response`, { text: 'Te esperamos' }, shop.owner.token)
        .expect(200);
      const list = await publicList(shop.shopId);
      expect(list.body.items[0].response.text).toBe('Te esperamos');
      const audit = await prisma.auditLog.findMany({
        where: { entityId: reviewId, action: { startsWith: 'review.response' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((x) => x.action)).toEqual([
        'review.response_created',
        'review.response_updated',
      ]);
      expect(JSON.stringify(audit.map((x) => x.changes))).not.toContain('esperamos');
    });
  });

  // ───────────── Reportes y moderación ─────────────

  describe('RF-VAL-002 reportes y moderación', () => {
    it('3 reportes distintos: UNDER_REVIEW y sigue visible; nadie reporta dos veces', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const r = await review(a.person, a.id, { rating: 1, comment: 'Pésimo' }).expect(201);
      const reviewId = r.body.id as string;
      // El autor no reporta su propia valoración.
      await report(a.person, reviewId, { reason: 'SPAM' }).expect(403);
      await report(await verified(), reviewId, { reason: 'NOPE' }).expect(400);

      const reporters = [await verified(), await verified(), await verified()];
      await report(reporters[0]!, reviewId, { reason: 'OFFENSIVE', details: 'Insulta' }).expect(
        204,
      );
      expect(
        (await report(reporters[0]!, reviewId, { reason: 'SPAM' }).expect(409)).body.code,
      ).toBe('ALREADY_REPORTED');
      await report(reporters[1]!, reviewId, { reason: 'FAKE' }).expect(204);
      expect((await prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
        'VISIBLE',
      );
      // La barbería también puede reportar la valoración.
      await report(
        { client: shop.owner.client, token: shop.owner.token, userId: '', username: '' },
        reviewId,
        {
          reason: 'FAKE',
        },
      ).expect(204);
      expect((await prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
        'UNDER_REVIEW',
      );
      expect((await publicList(shop.shopId)).body.items).toHaveLength(1);
      expect((await ratingOf(shop.shopId, shop.barberIds[0])).shop).toEqual([1, 1]);
      await report(reporters[2]!, reviewId, { reason: 'SPAM' }).expect(204);
      await new AuthClient(app)
        .post(`${API}/reviews/${reviewId}/reports`, { reason: 'SPAM' })
        .expect(401);
    });

    it('la respuesta también se reporta (no por la propia barbería) y se modera aparte', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const r = await review(a.person, a.id, { rating: 4 }).expect(201);
      const reviewId = r.body.id as string;
      await report(await verified(), reviewId, { target: 'RESPONSE', reason: 'SPAM' }).expect(404);
      await shop.owner.client
        .put(`${API}/reviews/${reviewId}/response`, { text: 'Respuesta' }, shop.owner.token)
        .expect(200);
      await report(
        { client: shop.owner.client, token: shop.owner.token, userId: '', username: '' },
        reviewId,
        {
          target: 'RESPONSE',
          reason: 'SPAM',
        },
      ).expect(403);
      // El autor de la valoración sí puede reportar la respuesta.
      await report(a.person, reviewId, { target: 'RESPONSE', reason: 'OFFENSIVE' }).expect(204);
      await report(await verified(), reviewId, { target: 'RESPONSE', reason: 'OFFENSIVE' }).expect(
        204,
      );
      await report(await verified(), reviewId, { target: 'RESPONSE', reason: 'OFFENSIVE' }).expect(
        204,
      );
      let row = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
      expect([row.status, row.responseStatus]).toEqual(['VISIBLE', 'UNDER_REVIEW']);

      const moderation = app.get(ReviewModerationService);
      const support = await verified();
      const hidden = await moderation.moderate(
        reviewId,
        'RESPONSE',
        'HIDE',
        support.userId,
        'Spam',
      );
      expect(hidden).toEqual({ status: 'HIDDEN', resolvedReports: 3 });
      row = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
      expect([row.status, row.responseStatus]).toEqual(['VISIBLE', 'HIDDEN']);
      expect((await publicList(shop.shopId)).body.items[0].response).toBeNull();
      // Editar la respuesta no la vuelve visible.
      await shop.owner.client
        .put(`${API}/reviews/${reviewId}/response`, { text: 'Otra' }, shop.owner.token)
        .expect(200);
      expect((await publicList(shop.shopId)).body.items[0].response).toBeNull();
      await moderation.moderate(reviewId, 'RESPONSE', 'RESTORE', support.userId, 'Revisado');
      expect((await publicList(shop.shopId)).body.items[0].response.text).toBe('Otra');
    });

    it('moderación: ocultar saca del listado y del promedio; restaurar los devuelve; auditado', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const b = await attendedBooking(shop, '11:00');
      const r = await review(a.person, a.id, { rating: 1 }).expect(201);
      await review(b.person, b.id, { rating: 5 }).expect(201);
      const reviewId = r.body.id as string;
      for (let i = 0; i < 3; i++) {
        await report(await verified(), reviewId, { reason: 'OFFENSIVE' }).expect(204);
      }
      const moderation = app.get(ReviewModerationService);
      const support = await verified();
      // KEEP: vuelve a VISIBLE y los reportes resueltos ya no cuentan.
      expect(await moderation.moderate(reviewId, 'REVIEW', 'KEEP', support.userId, 'Ok')).toEqual({
        status: 'VISIBLE',
        resolvedReports: 3,
      });
      await report(await verified(), reviewId, { reason: 'SPAM' }).expect(204);
      expect((await prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
        'VISIBLE',
      );
      await moderation.moderate(reviewId, 'REVIEW', 'HIDE', support.userId, 'Ofensiva');
      expect((await publicList(shop.shopId)).body.items).toHaveLength(1);
      expect(await ratingOf(shop.shopId, shop.barberIds[0])).toEqual({
        shop: [5, 1],
        barber: [5, 1],
      });
      // Una oculta no se reporta, y KEEP sobre una oculta no aplica.
      await report(await verified(), reviewId, { reason: 'SPAM' }).expect(404);
      await expect(
        moderation.moderate(reviewId, 'REVIEW', 'KEEP', support.userId, 'x'),
      ).rejects.toThrow();
      const mine = await a.person.client.get(`${API}/me/reviews`, a.person.token).expect(200);
      expect(mine.body.items[0].status).toBe('HIDDEN');
      await moderation.moderate(reviewId, 'REVIEW', 'RESTORE', support.userId, 'Revisado');
      expect((await ratingOf(shop.shopId, shop.barberIds[0])).shop).toEqual([3, 2]);
      const audit = await prisma.auditLog.findMany({
        where: { entityId: reviewId, action: 'review.moderated' },
      });
      expect(audit).toHaveLength(3);
      expect(audit.every((x) => x.actorId === support.userId)).toBe(true);
    });

    it('límite propio de valoraciones y reportes por cuenta', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const r = await review(a.person, a.id, { rating: 3 }).expect(201);
      REVIEW_RATE_LIMIT.set(2);
      const me = await verified();
      await report(me, r.body.id, { reason: 'SPAM' }).expect(204);
      await report(me, r.body.id, { reason: 'SPAM' }).expect(409);
      expect((await report(me, r.body.id, { reason: 'SPAM' }).expect(429)).body.code).toBe(
        'TOO_MANY_REQUESTS',
      );
      // Otra cuenta no se ve afectada.
      await report(await verified(), r.body.id, { reason: 'SPAM' }).expect(204);
    });
  });

  // ───────────── Integración con la Fase 9 ─────────────

  describe('corrección de asistencia (Fase 9)', () => {
    const correct = (shop: Shop, id: string, status: string) =>
      shop.owner.client
        .post(
          `${API}/bookings/${id}/attendance-correction`,
          { status, reason: 'Error al marcar' },
          shop.owner.token,
        )
        .expect(200);

    it('a NO_SHOW oculta la valoración; de vuelta a ATTENDED la restaura; idempotente', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const r = await review(a.person, a.id, { rating: 2 }).expect(201);
      const reviewId = r.body.id as string;
      await correct(shop, a.id, 'NO_SHOW');
      await relayAll();
      let row = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
      expect([row.status, row.hiddenReason]).toEqual(['HIDDEN', 'attendance_corrected']);
      expect((await ratingOf(shop.shopId, shop.barberIds[0])).shop).toEqual([0, 0]);
      // Soporte no la restaura a mano: depende de la asistencia.
      const support = await verified();
      await expect(
        app
          .get(ReviewModerationService)
          .moderate(reviewId, 'REVIEW', 'RESTORE', support.userId, 'x'),
      ).rejects.toThrow(/asistencia/);

      await correct(shop, a.id, 'ATTENDED');
      await relayAll();
      row = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
      expect([row.status, row.hiddenReason]).toEqual(['VISIBLE', null]);
      expect((await ratingOf(shop.shopId, shop.barberIds[0])).shop).toEqual([2, 1]);
      // Reprocesar (entrega repetida) no cambia nada.
      await app.get(ReviewModerationService).syncWithAttendance(a.id);
      expect((await ratingOf(shop.shopId, shop.barberIds[0])).shop).toEqual([2, 1]);
    });

    it('si la ocultó soporte, volver a ATTENDED no la restaura', async () => {
      const shop = await shopReady();
      const a = await attendedBooking(shop, '10:00');
      const r = await review(a.person, a.id, { rating: 2 }).expect(201);
      const support = await verified();
      await app
        .get(ReviewModerationService)
        .moderate(r.body.id, 'REVIEW', 'HIDE', support.userId, 'Ofensiva');
      await correct(shop, a.id, 'NO_SHOW');
      await relayAll();
      await correct(shop, a.id, 'ATTENDED');
      await relayAll();
      const row = await prisma.review.findUniqueOrThrow({ where: { id: r.body.id } });
      expect([row.status, row.hiddenReason]).toEqual(['HIDDEN', 'moderation']);
    });
  });

  // ───────────── Verificación nocturna ─────────────

  it('RF-VAL-003 la verificación nocturna corrige promedios descuadrados y lo audita', async () => {
    const shop = await shopReady();
    const a = await attendedBooking(shop, '10:00');
    await review(a.person, a.id, { rating: 4 }).expect(201);
    await prisma.barbershop.update({
      where: { id: shop.shopId },
      data: { ratingAvg: 1.11, ratingCount: 9 },
    });
    await prisma.barber.update({
      where: { id: shop.barberIds[1] },
      data: { ratingAvg: 2, ratingCount: 1 },
    });
    const verifier = app.get(RatingsVerifier);
    const fixed = await verifier.verifyAll();
    expect(fixed.barbershops).toBeGreaterThanOrEqual(1);
    expect(fixed.barbers).toBeGreaterThanOrEqual(1);
    expect(await ratingOf(shop.shopId, shop.barberIds[1])).toEqual({
      shop: [4, 1],
      barber: [0, 0],
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'rating.corrected', entityId: shop.shopId },
    });
    expect(audit.changes).toEqual({
      before: { average: 1.11, count: 9 },
      after: { average: 4, count: 1 },
    });
    // Sin descuadres, no hay nada que corregir en esta barbería.
    await verifier.verifyAll();
    expect(
      await prisma.auditLog.count({ where: { action: 'rating.corrected', entityId: shop.shopId } }),
    ).toBe(1);
  });
});
