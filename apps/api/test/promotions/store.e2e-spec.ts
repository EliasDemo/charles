import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import ffmpegPath from 'ffmpeg-static';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { VideosService } from '../../src/modules/videos/videos.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { staffToken } from '../support/mfa';

function testVideo(seconds: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'charles-store-video-'));
  try {
    const file = join(dir, 'in.mp4');
    execFileSync(
      ffmpegPath!,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc=size=640x360:rate=15:duration=${seconds}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        file,
      ],
      { stdio: 'ignore' },
    );
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Tienda: marcas por rubro, ofertas reales, público, videos de marcas, clics y descuentos. */
describe('Tienda de auspiciadores (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  let boss: Person;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };
  const anon = () => new AuthClient(app);

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    kit = bookingKit(app, clock);
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    boss = { client, token: tokens.accessToken, userId: tokens.user.id, email };
    await prisma.userRole.create({ data: { userId: boss.userId, role: 'ADMIN' } });
    boss.token = await staffToken(app, boss);
  });
  afterAll(() => app.close());

  async function brand(body: Record<string, unknown>): Promise<string> {
    const res = await boss.client.post(`${API}/admin/sponsors`, body, boss.token).expect(201);
    return res.body.id as string;
  }

  function product(sponsorId: string, body: Record<string, unknown>) {
    return boss.client.post(
      `${API}/admin/sponsors/${sponsorId}/products`,
      { actionUrl: 'https://tienda.example.com/p', ...body },
      boss.token,
    );
  }

  it('ficha de la marca y ofertas coherentes: precio normal, oferta menor, cupón y vencimiento', async () => {
    const id = await brand({
      name: 'Ceras del Sur',
      category: 'COSMETICS',
      description: 'Ceras y pomadas hechas en Arequipa.',
      websiteUrl: 'https://ceras.example.com',
    });
    const listed = await boss.client.get(`${API}/admin/sponsors`, boss.token).expect(200);
    expect(listed.body.find((s: { id: string }) => s.id === id)).toMatchObject({
      category: 'COSMETICS',
      websiteUrl: 'https://ceras.example.com',
      videos: 0,
    });
    await boss.client
      .patch(`${API}/admin/sponsors/${id}`, { websiteUrl: 'http://inseguro.example' }, boss.token)
      .expect(400);
    await boss.client
      .patch(`${API}/admin/sponsors/${id}`, { category: 'JUGUETES' }, boss.token)
      .expect(400);

    // Oferta sin precio normal, u oferta igual o mayor: 400.
    expect(
      (await product(id, { name: 'Cera mate', offerPriceAmount: 2000 }).expect(400)).body
        .details[0],
    ).toMatchObject({ field: 'offerPriceAmount', constraints: ['requiresPriceAmount'] });
    await product(id, { name: 'Cera mate', priceAmount: 2000, offerPriceAmount: 2000 }).expect(400);
    await product(id, { name: 'Cera mate', priceAmount: 2000, couponCode: 'no válido' }).expect(
      400,
    );

    const created = await product(id, {
      name: 'Cera mate 100 g',
      audience: 'CLIENTS',
      priceAmount: 3000,
      offerPriceAmount: 2250,
      couponCode: 'charles10',
      priceText: 'Frasco de 100 g',
    }).expect(201);
    expect(created.body).toMatchObject({
      priceAmount: 3000,
      offerPriceAmount: 2250,
      couponCode: 'CHARLES10',
      offerActive: true,
      discountPercent: 25,
      clicks: 0,
      currency: 'PEN',
    });
    // Subir la oferta por encima del precio guardado: 400; quitarla: ya no hay descuento.
    await boss.client
      .patch(`${API}/admin/products/${created.body.id}`, { offerPriceAmount: 3500 }, boss.token)
      .expect(400);
    const cleared = await boss.client
      .patch(`${API}/admin/products/${created.body.id}`, { offerPriceAmount: null }, boss.token)
      .expect(200);
    expect(cleared.body).toMatchObject({ offerActive: false, discountPercent: null });
  });

  it('la Tienda separa público y rubro, ordena las ofertas y oculta lo vencido o inactivo', async () => {
    const cosmetics = await brand({ name: 'Barba Noble', category: 'COSMETICS' });
    const tools = await brand({ name: 'Filo Pro', category: 'TOOLS' });
    const hidden = await brand({ name: 'Marca Pausada', category: 'COSMETICS' });

    const oil = await product(cosmetics, {
      name: 'Aceite de barba',
      audience: 'CLIENTS',
      priceAmount: 4000,
      offerPriceAmount: 2000,
    }).expect(201);
    const balm = await product(cosmetics, {
      name: 'Bálsamo',
      audience: 'ALL',
      priceAmount: 3000,
      offerPriceAmount: 2700,
    }).expect(201);
    const expired = await product(cosmetics, {
      name: 'Shampoo',
      audience: 'CLIENTS',
      priceAmount: 2500,
      offerPriceAmount: 2000,
      couponCode: 'VIEJO',
      offerEndsAt: new Date(lima(MONDAY, '07:00')).toISOString(),
    }).expect(201);
    const clipper = await product(tools, {
      name: 'Máquina inalámbrica',
      audience: 'BARBERSHOPS',
      priceAmount: 35000,
      offerPriceAmount: 29900,
    }).expect(201);
    await product(hidden, { name: 'No debe verse', audience: 'ALL' }).expect(201);
    await boss.client
      .patch(`${API}/admin/sponsors/${hidden}`, { isActive: false }, boss.token)
      .expect(200);

    const clients = (await anon().get(`${API}/store`).expect(200)).body;
    const offerIds = clients.offers.map((p: { id: string }) => p.id);
    expect(offerIds).toEqual(expect.arrayContaining([oil.body.id, balm.body.id]));
    expect(offerIds.indexOf(oil.body.id)).toBeLessThan(offerIds.indexOf(balm.body.id));
    expect(offerIds).not.toContain(clipper.body.id);
    expect(clients.offers.find((p: { id: string }) => p.id === oil.body.id)).toMatchObject({
      discountPercent: 50,
      sponsorName: 'Barba Noble',
      category: 'COSMETICS',
    });
    // La oferta vencida pasa a "productos", sin precio de oferta ni cupón.
    expect(clients.products.find((p: { id: string }) => p.id === expired.body.id)).toMatchObject({
      offerPriceAmount: null,
      couponCode: null,
      discountPercent: null,
      priceAmount: 2500,
    });
    const names = [...clients.offers, ...clients.products].map((p: { name: string }) => p.name);
    expect(names).not.toContain('No debe verse');
    expect(clients.brands.find((b: { id: string }) => b.id === cosmetics)).toMatchObject({
      productCount: 3,
      hasOffers: true,
    });
    expect(clients.brands.map((b: { id: string }) => b.id)).not.toContain(tools);
    expect(clients.categories).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: 'COSMETICS' })]),
    );

    const shops = (await anon().get(`${API}/store?audience=BARBERSHOPS`).expect(200)).body;
    const shopIds = [...shops.offers, ...shops.products].map((p: { id: string }) => p.id);
    expect(shopIds).toEqual(expect.arrayContaining([clipper.body.id, balm.body.id]));
    expect(shopIds).not.toContain(oil.body.id);
    expect(shops.deals).toEqual([]);

    const onlyTools = (
      await anon().get(`${API}/store?audience=BARBERSHOPS&category=TOOLS`).expect(200)
    ).body;
    expect(
      [...onlyTools.offers, ...onlyTools.products].every(
        (p: { category: string }) => p.category === 'TOOLS',
      ),
    ).toBe(true);
    await anon().get(`${API}/store?category=JUGUETES`).expect(400);

    // La ficha pública de la marca trae sus datos, productos sin métricas y videos.
    const page = (await anon().get(`${API}/sponsors/${cosmetics}`).expect(200)).body;
    expect(page).toMatchObject({ category: 'COSMETICS', videos: [] });
    expect(page.products[0]).not.toHaveProperty('clicks');
  });

  it('destacado de la Tienda por público y descuentos de reservas de Charles y de barberías', async () => {
    // Termina destacados de corridas anteriores (la base de pruebas se conserva).
    await prisma.sponsorCampaign.updateMany({
      where: { placements: { some: { slotKey: 'store_featured' } } },
      data: { status: 'ENDED' },
    });
    const id = await brand({ name: 'Sillones Rex', category: 'FURNITURE' });
    for (const audience of ['BARBERSHOPS', 'CLIENTS'] as const) {
      const campaign = await boss.client
        .post(
          `${API}/admin/sponsors/${id}/campaigns`,
          {
            name: `Tienda ${audience}`,
            startsAt: new Date(lima(MONDAY, '07:00')).toISOString(),
            endsAt: new Date(lima(MONDAY, '20:00')).toISOString(),
            audience,
          },
          boss.token,
        )
        .expect(201);
      await boss.client
        .post(
          `${API}/admin/campaigns/${campaign.body.id}/placements`,
          { slotKey: 'store_featured', title: `Para ${audience}` },
          boss.token,
        )
        .expect(201);
      await boss.client
        .patch(`${API}/admin/campaigns/${campaign.body.id}`, { status: 'ACTIVE' }, boss.token)
        .expect(200);
    }
    const forClients = (await anon().get(`${API}/store`).expect(200)).body;
    expect(forClients.featured.map((f: { title: string }) => f.title)).toEqual(['Para CLIENTS']);
    const forShops = (await anon().get(`${API}/store?audience=BARBERSHOPS`).expect(200)).body;
    expect(forShops.featured.map((f: { title: string }) => f.title)).toEqual(['Para BARBERSHOPS']);

    const platform = await boss.client
      .post(
        `${API}/admin/promotions`,
        { name: 'Lunes de Charles', type: 'PERCENTAGE', value: 10 },
        boss.token,
      )
      .expect(201);
    const shop = await kit.shopReady();
    const local = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/promotions`,
        { name: 'Promo del barrio', type: 'PERCENTAGE', value: 15 },
        shop.owner.token,
      )
      .expect(201);
    const gold = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/promotions`,
        { name: 'Solo clientes Oro', type: 'PERCENTAGE', value: 30, minTier: 'GOLD' },
        shop.owner.token,
      )
      .expect(201);
    const deals = (await anon().get(`${API}/store`).expect(200)).body.deals;
    expect(deals.find((d: { id: string }) => d.id === platform.body.id)).toMatchObject({
      fromCharles: true,
      barbershopId: null,
    });
    expect(deals.find((d: { id: string }) => d.id === local.body.id)).toMatchObject({
      fromCharles: false,
      barbershopId: shop.shopId,
      value: 15,
    });
    // Un descuento con nivel mínimo no vale para cualquiera: no se anuncia.
    expect(deals.map((d: { id: string }) => d.id)).not.toContain(gold.body.id);
  });

  it('clics a la tienda: uno por persona y hora, se ven en el panel', async () => {
    const id = await brand({ name: 'Tijeras Andinas', category: 'TOOLS' });
    const item = await product(id, { name: 'Tijera 6"', priceAmount: 9000 }).expect(201);
    const click = (body: object, who?: Person) =>
      who
        ? who.client.post(`${API}/store/products/${item.body.id}/click`, body, who.token)
        : anon().post(`${API}/store/products/${item.body.id}/click`, body);

    const fan = await kit.verified();
    await click({}, fan).expect(204);
    await click({}, fan).expect(204);
    const viewerKey = '0190a5b2-1c2d-7e3f-8a9b-0c1d2e3f4a5b';
    await click({ viewerKey }).expect(204);
    await click({ viewerKey }).expect(204);
    await click({}).expect(400);
    await anon()
      .post(`${API}/store/products/00000000-0000-7000-8000-000000000000/click`, { viewerKey })
      .expect(404);

    clock.current += 3_600_000;
    await click({}, fan).expect(204);
    clock.current -= 3_600_000;

    const list = await boss.client
      .get(`${API}/admin/sponsors/${id}/products`, boss.token)
      .expect(200);
    expect(list.body[0].clicks).toBe(3);
  });

  it('videos de la marca: el panel los sube y borra; se ven en la ficha y en la Tienda', async () => {
    const id = await brand({ name: 'Pomadas Inca', category: 'COSMETICS' });
    await product(id, { name: 'Pomada', audience: 'CLIENTS', priceAmount: 2800 }).expect(201);
    const upload = (who: Person) =>
      who.client.http
        .post(`${API}/admin/sponsors/${id}/videos`)
        .set('X-Forwarded-For', who.client.ip)
        .set('Authorization', `Bearer ${who.token}`)
        .field('caption', 'Cómo peinar con pomada')
        .attach('file', testVideo(2), { filename: 'video.mp4', contentType: 'video/mp4' });

    const outsider = await kit.verified();
    await upload(outsider).expect(403);
    const res = await upload(boss).expect(202);
    expect(res.body).toMatchObject({ status: 'PROCESSING' });
    await app.get(VideosService).process(res.body.id as string);

    const managed = await boss.client.get(`${API}/admin/sponsors/${id}/videos`, boss.token);
    expect(managed.body).toEqual([expect.objectContaining({ id: res.body.id, status: 'READY' })]);
    const page = (await anon().get(`${API}/sponsors/${id}`).expect(200)).body;
    expect(page.videos).toEqual([
      expect.objectContaining({ id: res.body.id, caption: 'Cómo peinar con pomada' }),
    ]);
    const store = (await anon().get(`${API}/store?category=COSMETICS`).expect(200)).body;
    expect(store.videos.find((v: { id: string }) => v.id === res.body.id)).toMatchObject({
      sponsorId: id,
      sponsorName: 'Pomadas Inca',
    });
    // Sus productos son para clientes: el video no se muestra a las barberías.
    const forShops = (await anon().get(`${API}/store?audience=BARBERSHOPS`).expect(200)).body;
    expect(forShops.videos.map((v: { id: string }) => v.id)).not.toContain(res.body.id);

    await boss.client.delete(`${API}/admin/sponsor-videos/${res.body.id}`, boss.token).expect(204);
    await boss.client.delete(`${API}/admin/sponsor-videos/${res.body.id}`, boss.token).expect(404);
    expect((await anon().get(`${API}/sponsors/${id}`).expect(200)).body.videos).toEqual([]);
  });
});
