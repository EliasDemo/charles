import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { staffToken } from '../support/mfa';

/** Fase 13B y 13C: destacados en la búsqueda y auspiciadores. */
describe('Destacados y auspiciadores (e2e, Fase 13)', () => {
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

  // ───────────── Destacados ─────────────

  it('un destacado vigente sube al inicio de la primera página con featured=true', async () => {
    const [first, second] = [await kit.shopReady(), await kit.shopReady()];
    await prisma.barbershop.updateMany({
      where: { id: { in: [first.shopId, second.shopId] } },
      data: { name: 'Zeta Featured Test' },
    });
    const created = await boss.client
      .post(
        `${API}/admin/featured`,
        {
          barbershopId: second.shopId,
          endsAt: new Date(lima(MONDAY, '20:00')).toISOString(),
          priority: 10,
        },
        boss.token,
      )
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'ACTIVE',
      barbershopId: second.shopId,
      priority: 10,
    });

    const search = await new AuthClient(app)
      .get(`${API}/search/barbershops?q=Zeta%20Featured&sort=rating&limit=50`)
      .expect(200);
    const ids = search.body.items.map((i: { id: string }) => i.id);
    expect(ids[0]).toBe(second.shopId);
    expect(search.body.items[0].featured).toBe(true);
    const other = search.body.items.find((i: { id: string }) => i.id === first.shopId);
    if (other) expect(other.featured).toBe(false);

    // Retirado, deja de destacarse.
    await boss.client.delete(`${API}/admin/featured/${created.body.id}`, boss.token).expect(200);
    const after = await new AuthClient(app)
      .get(`${API}/search/barbershops?q=Zeta%20Featured&sort=rating&limit=50`)
      .expect(200);
    expect(after.body.items.every((i: { featured: boolean }) => !i.featured)).toBe(true);
    const list = await boss.client
      .get(`${API}/admin/featured?includePast=true`, boss.token)
      .expect(200);
    expect(list.body.find((f: { id: string }) => f.id === created.body.id).status).toBe(
      'CANCELLED',
    );
  });

  it('destacados: validaciones y solo ADMIN', async () => {
    const shop = await kit.shopReady();
    await boss.client
      .post(
        `${API}/admin/featured`,
        { barbershopId: shop.shopId, endsAt: new Date(lima(MONDAY, '07:00')).toISOString() },
        boss.token,
      )
      .expect(400);
    await shop.owner.client.get(`${API}/admin/featured`, shop.owner.token).expect(403);
  });

  // ───────────── Auspiciadores ─────────────

  it('campaña publicada: anuncio por espacio y público, eventos sin duplicar y métricas', async () => {
    const sponsor = await boss.client
      .post(
        `${API}/admin/sponsors`,
        { name: 'Ceras Pro', contact: 'ventas@ceras.example' },
        boss.token,
      )
      .expect(201);
    expect(sponsor.body).toMatchObject({ name: 'Ceras Pro', contact: 'ventas@ceras.example' });
    const raw = await prisma.sponsor.findUniqueOrThrow({ where: { id: sponsor.body.id } });
    expect(raw.contactEnc).not.toContain('ceras');

    const png = await sharp({
      create: { width: 800, height: 400, channels: 3, background: '#c8641f' },
    })
      .png()
      .toBuffer();
    const media = await boss.client.http
      .post(`${API}/admin/sponsors/media`)
      .set('X-Forwarded-For', boss.client.ip)
      .set('Authorization', `Bearer ${boss.token}`)
      .attach('file', png, { filename: 'banner.png', contentType: 'image/png' })
      .expect(201);
    expect(media.body.url).toMatch(/large\.webp$/);

    const campaign = await boss.client
      .post(
        `${API}/admin/sponsors/${sponsor.body.id}/campaigns`,
        {
          name: 'Lanzamiento',
          startsAt: new Date(lima(MONDAY, '07:00')).toISOString(),
          endsAt: new Date(lima(MONDAY, '23:00')).toISOString(),
          audience: 'CLIENTS',
        },
        boss.token,
      )
      .expect(201);
    expect(campaign.body).toMatchObject({ status: 'DRAFT', live: false });
    const withPlacement = await boss.client
      .post(
        `${API}/admin/campaigns/${campaign.body.id}/placements`,
        {
          slotKey: 'home_banner',
          title: 'Cera mate 2x1',
          imageUrl: media.body.url,
          actionUrl: 'https://ceras.example/promo',
          priority: 5,
        },
        boss.token,
      )
      .expect(201);
    const placementId = withPlacement.body.placements[0].id as string;
    await boss.client
      .post(
        `${API}/admin/campaigns/${campaign.body.id}/placements`,
        { slotKey: 'home_banner', title: 'Mal', actionUrl: 'http://inseguro.example' },
        boss.token,
      )
      .expect(400);

    // En borrador no se muestra.
    const visitor = new AuthClient(app);
    expect((await visitor.get(`${API}/placements?slot=home_banner`).expect(200)).body).toEqual([]);
    await boss.client
      .patch(`${API}/admin/campaigns/${campaign.body.id}`, { status: 'ACTIVE' }, boss.token)
      .expect(200);
    const shown = await visitor.get(`${API}/placements?slot=home_banner`).expect(200);
    expect(shown.body).toEqual([
      expect.objectContaining({
        id: placementId,
        title: 'Cera mate 2x1',
        sponsorName: 'Ceras Pro',
      }),
    ]);
    // Público de clientes: no aparece en la pantalla de la barbería.
    expect((await visitor.get(`${API}/placements?slot=shop_dashboard`).expect(200)).body).toEqual(
      [],
    );
    await visitor.get(`${API}/placements?slot=otro`).expect(400);

    // Una impresión por persona y hora; anónimos con viewerKey; sin viewerKey ni sesión, 400.
    const viewerKey = '7d1f8a6c-1e2b-4c3d-9e8f-0a1b2c3d4e5f';
    for (let i = 0; i < 3; i++) {
      await visitor
        .post(`${API}/placements/${placementId}/events`, { type: 'IMPRESSION', viewerKey })
        .expect(204);
    }
    await visitor
      .post(`${API}/placements/${placementId}/events`, { type: 'CLICK', viewerKey })
      .expect(204);
    const someone = await kit.verified();
    await someone.client
      .post(`${API}/placements/${placementId}/events`, { type: 'IMPRESSION' }, someone.token)
      .expect(204);
    await visitor
      .post(`${API}/placements/${placementId}/events`, { type: 'IMPRESSION' })
      .expect(400);
    expect(await prisma.sponsorEvent.count({ where: { placementId, userId: null } })).toBe(2);

    const metrics = await boss.client
      .get(`${API}/admin/campaigns/${campaign.body.id}/metrics`, boss.token)
      .expect(200);
    expect(metrics.body).toMatchObject({ impressions: 2, clicks: 1, ctr: 0.5 });

    // Con eventos, el anuncio no se borra (se pausa o termina la campaña).
    await boss.client.delete(`${API}/admin/placements/${placementId}`, boss.token).expect(409);
    await boss.client
      .patch(`${API}/admin/campaigns/${campaign.body.id}`, { status: 'ENDED' }, boss.token)
      .expect(200);
    await boss.client
      .patch(`${API}/admin/campaigns/${campaign.body.id}`, { status: 'ACTIVE' }, boss.token)
      .expect(409);
    expect((await visitor.get(`${API}/placements?slot=home_banner`).expect(200)).body).toEqual([]);
  });

  it('catálogo de productos: solo los activos se ven y los enlaces deben ser https', async () => {
    const sponsor = await boss.client
      .post(`${API}/admin/sponsors`, { name: 'Navajas SA' }, boss.token)
      .expect(201);
    const base = `${API}/admin/sponsors/${sponsor.body.id}/products`;
    const product = await boss.client
      .post(
        base,
        { name: 'Navaja clásica', actionUrl: 'https://navajas.example/1', priceText: 'S/ 49.90' },
        boss.token,
      )
      .expect(201);
    await boss.client
      .post(base, { name: 'Otra', actionUrl: 'ftp://x.example' }, boss.token)
      .expect(400);
    const hidden = await boss.client
      .post(base, { name: 'Oculta', actionUrl: 'https://navajas.example/2' }, boss.token)
      .expect(201);
    await boss.client
      .patch(`${API}/admin/products/${hidden.body.id}`, { isActive: false }, boss.token)
      .expect(200);

    const page = await new AuthClient(app).get(`${API}/sponsors/${sponsor.body.id}`).expect(200);
    expect(page.body.products.map((p: { id: string }) => p.id)).toEqual([product.body.id]);
    await boss.client
      .patch(`${API}/admin/sponsors/${sponsor.body.id}`, { isActive: false }, boss.token)
      .expect(200);
    await new AuthClient(app).get(`${API}/sponsors/${sponsor.body.id}`).expect(404);
    await kit.verified().then((p) => p.client.get(`${API}/admin/sponsors`, p.token).expect(403));
  });
});
