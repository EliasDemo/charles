import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY } from '../support/bookings';

describe('RF-FAV-001 isFavorite en la ficha y en la búsqueda (e2e)', () => {
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
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => app.close());

  /** Dos barberías con un nombre único (para filtrarlas con q); la cuenta marca solo la primera. */
  async function setup() {
    const tag = `Fav${randomUUID().slice(0, 8)}`;
    const a = await kit.shopReady();
    const b = await kit.shopReady();
    await prisma.barbershop.update({ where: { id: a.shopId }, data: { name: `${tag} Uno` } });
    await prisma.barbershop.update({ where: { id: b.shopId }, data: { name: `${tag} Dos` } });
    const me = await kit.verified();
    await me.client.put(`${API}/me/favorites/${a.shopId}`, {}, me.token).expect(204);
    return { tag, a, b, me };
  }

  const searchUrl = (tag: string) =>
    `${API}/search/barbershops?lat=-12.12&lng=-77.03&q=${encodeURIComponent(tag)}&limit=50`;

  it('ficha: true para la favorita con sesión; false sin sesión, para otra cuenta o con un token no válido', async () => {
    const { a, b, me } = await setup();
    const get = (id: string, token?: string) =>
      new AuthClient(app).get(`${API}/barbershops/${id}`, token).expect(200);
    expect((await get(a.shopId, me.token)).body.isFavorite).toBe(true);
    expect((await get(b.shopId, me.token)).body.isFavorite).toBe(false);
    expect((await get(a.shopId)).body.isFavorite).toBe(false);
    const other = await kit.verified();
    expect((await get(a.shopId, other.token)).body.isFavorite).toBe(false);
    // Un token inválido en un endpoint público no es un error: responde como anónimo.
    expect((await get(a.shopId, 'no-es-un-token')).body.isFavorite).toBe(false);
    // Una sesión cerrada tampoco personaliza.
    await me.client.post(`${API}/auth/logout`, { allDevices: false }, me.token).expect(204);
    expect((await get(a.shopId, me.token)).body.isFavorite).toBe(false);
  });

  it('búsqueda: marca solo las favoritas, con una sola consulta de favoritos por página', async () => {
    const { tag, a, b, me } = await setup();
    const spy = jest.spyOn(prisma.favorite, 'findMany');
    const withSession = await new AuthClient(app).get(searchUrl(tag), me.token).expect(200);
    const byId = new Map(
      withSession.body.items.map((i: { id: string; isFavorite: boolean }) => [i.id, i.isFavorite]),
    );
    expect(byId.get(a.shopId)).toBe(true);
    expect(byId.get(b.shopId)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    const anonymous = await new AuthClient(app).get(searchUrl(tag)).expect(200);
    expect(anonymous.body.items.length).toBeGreaterThanOrEqual(2);
    expect(anonymous.body.items.every((i: { isFavorite: boolean }) => i.isFavorite === false)).toBe(
      true,
    );
    // Sin sesión no se consulta la tabla de favoritos.
    expect(spy).not.toHaveBeenCalled();
  });

  it('una sesión restringida (cuenta deshabilitada) no personaliza', async () => {
    const { a } = await setup();
    const client = new AuthClient(app);
    const { email, password, tokens } = await client.newUser();
    await prisma.favorite.create({ data: { clientId: tokens.user.id, barbershopId: a.shopId } });
    await prisma.user.update({ where: { id: tokens.user.id }, data: { status: 'DISABLED' } });
    const restricted = await client
      .post(`${API}/auth/support-access`, { email, password })
      .expect(200);
    const res = await client
      .get(`${API}/barbershops/${a.shopId}`, restricted.body.accessToken as string)
      .expect(200);
    expect(res.body.isFavorite).toBe(false);
  });
});
