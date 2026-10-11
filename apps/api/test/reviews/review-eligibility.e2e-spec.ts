import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REVIEW_RATE_LIMIT } from '../../src/modules/reviews/review-rate-limit';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, HOUR, lima, MONDAY } from '../support/bookings';

const DAY = 24 * HOUR;

describe('M9: canReview, review, pendientes de valorar y valoraciones de mi barbería (e2e)', () => {
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
    REVIEW_RATE_LIMIT.set(1000);
  });
  afterAll(() => app.close());

  it('canReview y review siguen la regla: atendida, una vez y dentro de 14 días', async () => {
    const shop = await kit.shopReady();
    const client = await kit.verified();
    const confirmed = await kit.confirmed(shop, lima(MONDAY, '10:00'), client);
    const get = async (id: string) =>
      (await client.client.get(`${API}/bookings/${id}`, client.token).expect(200)).body;

    // Confirmada: todavía no.
    expect(await get(confirmed.id)).toMatchObject({ canReview: false, review: null });

    const attended = await kit.attended(shop, lima(MONDAY, '11:00'), client);
    expect(await get(attended.id)).toMatchObject({ canReview: true, review: null });
    const pending = await client.client
      .get(`${API}/me/bookings/pending-reviews`, client.token)
      .expect(200);
    expect(pending.body.items.map((b: { id: string }) => b.id)).toEqual([attended.id]);
    expect(pending.body.items[0]).toMatchObject({ canReview: true, status: 'ATTENDED' });

    // Valorada: ya no se puede valorar; trae la propia con canEdit.
    const review = await client.client
      .post(`${API}/bookings/${attended.id}/review`, { rating: 4 }, client.token)
      .expect(201);
    expect(await get(attended.id)).toMatchObject({
      canReview: false,
      review: { id: review.body.id, rating: 4, canEdit: true },
    });
    expect(
      (await client.client.get(`${API}/me/bookings/pending-reviews`, client.token).expect(200)).body
        .items,
    ).toEqual([]);

    // Editada una vez: canEdit false. En la lista de historial, lo mismo.
    await client.client
      .patch(`${API}/reviews/${review.body.id}`, { rating: 5 }, client.token)
      .expect(200);
    const history = await client.client
      .get(`${API}/me/bookings?scope=history`, client.token)
      .expect(200);
    expect(history.body.items.find((b: { id: string }) => b.id === attended.id)).toMatchObject({
      canReview: false,
      review: { rating: 5, canEdit: false },
    });

    // Retirada: no vuelve a ser valorable (una por reserva).
    await client.client.delete(`${API}/reviews/${review.body.id}`, client.token).expect(204);
    expect(await get(attended.id)).toMatchObject({ canReview: false, review: null });

    // La barbería ve la reserva sin estos datos del cliente.
    const staffView = await shop.owner.client
      .get(`${API}/bookings/${attended.id}`, shop.owner.token)
      .expect(200);
    expect(staffView.body).toMatchObject({ canReview: false, review: null });
  });

  it('fuera de plazo deja de ser valorable; pendientes en orden, de la más reciente', async () => {
    const shop = await kit.shopReady([1, 2, 3, 4, 5]);
    const client = await kit.verified();
    const first = await kit.attended(shop, lima(MONDAY, '10:00'), client);
    clock.current = lima(MONDAY, '08:00') + DAY; // martes, antes del turno
    const second = await kit.attended(shop, lima('2030-01-08', '10:00'), client);

    const ids = async () =>
      (
        await client.client.get(`${API}/me/bookings/pending-reviews`, client.token).expect(200)
      ).body.items.map((b: { id: string }) => b.id);
    expect(await ids()).toEqual([second.id, first.id]);

    // 14 días después de la primera: solo queda la segunda.
    clock.current = lima(MONDAY, '10:00') + 14 * DAY + HOUR;
    expect(await ids()).toEqual([second.id]);
    const firstView = await client.client
      .get(`${API}/bookings/${first.id}`, client.token)
      .expect(200);
    expect(firstView.body.canReview).toBe(false);
    await client.client
      .post(`${API}/bookings/${first.id}/review`, { rating: 3 }, client.token)
      .expect(409);

    // Otra cuenta no ve pendientes ajenas.
    const stranger = await kit.verified();
    expect(
      (await stranger.client.get(`${API}/me/bookings/pending-reviews`, stranger.token).expect(200))
        .body.items,
    ).toEqual([]);
  });

  it('GET /me/barbershops/{id}/reviews: todas con su estado y canRespond; solo OWNER o MANAGER', async () => {
    const shop = await kit.shopReady();
    const client = await kit.verified();
    const booking = await kit.attended(shop, lima(MONDAY, '10:00'), client);
    const review = await client.client
      .post(
        `${API}/bookings/${booking.id}/review`,
        { rating: 2, comment: 'Muy lento' },
        client.token,
      )
      .expect(201);
    await shop.owner.client
      .put(
        `${API}/reviews/${review.body.id}/response`,
        { text: 'Gracias, mejoraremos' },
        shop.owner.token,
      )
      .expect(200);
    // Soporte la oculta: deja de ser pública, pero la barbería la sigue viendo.
    await prisma.review.update({
      where: { id: review.body.id as string },
      data: { status: 'HIDDEN', responseStatus: 'HIDDEN' },
    });
    const path = `${API}/me/barbershops/${shop.shopId}/reviews`;
    const managed = await shop.owner.client.get(path, shop.owner.token).expect(200);
    expect(managed.body.items).toHaveLength(1);
    expect(managed.body.items[0]).toMatchObject({
      id: review.body.id,
      rating: 2,
      status: 'HIDDEN',
      responseStatus: 'HIDDEN',
      response: { text: 'Gracias, mejoraremos' },
      canRespond: true,
    });
    const publicList = await new AuthClient(app)
      .get(`${API}/barbershops/${shop.shopId}/reviews`)
      .expect(200);
    expect(publicList.body.items).toHaveLength(0);

    // Filtros.
    expect(
      (await shop.owner.client.get(`${path}?status=VISIBLE`, shop.owner.token).expect(200)).body
        .items,
    ).toHaveLength(0);
    expect(
      (await shop.owner.client.get(`${path}?status=HIDDEN&rating=2`, shop.owner.token).expect(200))
        .body.items,
    ).toHaveLength(1);
    await shop.owner.client.get(`${path}?status=OTRO`, shop.owner.token).expect(400);

    // El barbero (cuenta vinculada) y un cliente no son miembros: 404.
    const barberUser = await kit.verified();
    await prisma.barber.update({
      where: { id: shop.barberId },
      data: { userId: barberUser.userId },
    });
    await barberUser.client.get(path, barberUser.token).expect(404);
    await client.client.get(path, client.token).expect(404);
  });
});
