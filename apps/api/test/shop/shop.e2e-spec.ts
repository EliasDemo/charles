import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, type KitShop, lima, MONDAY } from '../support/bookings';

/** Panel de gestión de la barbería: clientes y ranking, catálogo, caja, ventas, boletas y reportes. */
describe('Panel de la barbería (e2e)', () => {
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

  const sale = (shop: KitShop, body: Record<string, unknown>, key: string = randomUUID()) =>
    shop.owner.client
      .post(`${API}/barbershops/${shop.shopId}/sales`, body, shop.owner.token)
      .set('Idempotency-Key', key);

  it('clientes: del local, vinculados por usuario, búsqueda, historial y archivo', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const base = `${API}/barbershops/${shop.shopId}/clients`;
    const walkIn = await o.client
      .post(
        base,
        { displayName: 'Pedro del barrio', phone: '987 654 321', isRegular: true },
        o.token,
      )
      .expect(201);
    expect(walkIn.body).toMatchObject({
      displayName: 'Pedro del barrio',
      phone: '987 654 321',
      username: null,
      tier: 'NONE',
    });
    await o.client.post(base, {}, o.token).expect(400);

    const person = await kit.verified();
    const username = (await prisma.user.findUniqueOrThrow({ where: { id: person.userId } }))
      .username;
    const linked = await o.client.post(base, { username }, o.token).expect(201);
    expect(linked.body).toMatchObject({ displayName: 'Persona', username });
    await o.client.post(base, { username }, o.token).expect(409);
    await o.client.post(base, { username: 'nadie_existe_xyz' }, o.token).expect(404);

    const search = await o.client.get(`${base}?q=pedro`, o.token).expect(200);
    expect(search.body.map((c: { id: string }) => c.id)).toEqual([walkIn.body.id]);
    const regular = await o.client.get(`${base}?regular=true`, o.token).expect(200);
    expect(regular.body).toHaveLength(1);

    const updated = await o.client
      .patch(
        `${base}/${walkIn.body.id}`,
        { notes: 'Le gusta el degradado bajo', preferences: 'Máquina 1' },
        o.token,
      )
      .expect(200);
    expect(updated.body.notes).toBe('Le gusta el degradado bajo');
    const detail = await o.client.get(`${base}/${walkIn.body.id}`, o.token).expect(200);
    expect(detail.body.visits).toEqual([]);
    await o.client.patch(`${base}/${walkIn.body.id}`, { archived: true }, o.token).expect(200);
    expect((await o.client.get(base, o.token).expect(200)).body).toHaveLength(1);

    // Otra barbería no ve sus clientes.
    const other = await kit.shopReady();
    await other.owner.client.get(`${base}/${walkIn.body.id}`, other.owner.token).expect(404);
  });

  it('caja y ventas: efectivo exige caja, idempotencia, boleta simulada, anulación y cierre', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const base = `${API}/barbershops/${shop.shopId}`;
    const lines = [
      { serviceId: shop.serviceId },
      { description: 'Cera para peinar', unitAmount: 1500 },
    ];

    const noCash = await sale(shop, { lines, paymentMethod: 'CASH' }).expect(409);
    expect(noCash.body.code).toBe('CASH_SESSION_REQUIRED');
    await o.client.post(`${base}/sales`, { lines, paymentMethod: 'YAPE' }, o.token).expect(400);

    const opened = await o.client
      .post(`${base}/cash/open`, { openingAmount: 10000 }, o.token)
      .expect(201);
    expect(opened.body).toMatchObject({ openingAmount: 10000, closedAt: null, salesCount: 0 });
    await o.client.post(`${base}/cash/open`, { openingAmount: 0 }, o.token).expect(409);

    const key = randomUUID();
    const first = await sale(
      shop,
      { lines, discountAmount: 500, paymentMethod: 'CASH' },
      key,
    ).expect(201);
    expect(first.body).toMatchObject({
      subtotalAmount: 4000,
      discountAmount: 500,
      totalAmount: 3500,
      status: 'COMPLETED',
      invoice: null,
    });
    expect(first.body.lines[0]).toMatchObject({ description: 'Corte', unitAmount: 2500 });
    const replay = await sale(
      shop,
      { lines, discountAmount: 500, paymentMethod: 'CASH' },
      key,
    ).expect(200);
    expect(replay.body.id).toBe(first.body.id);
    await sale(shop, { lines, discountAmount: 9000, paymentMethod: 'CASH' }).expect(400);

    // Boleta: sin configurar, 409 (y no se crea la venta).
    const before = await prisma.localSale.count({ where: { barbershopId: shop.shopId } });
    const notConfigured = await sale(shop, {
      lines,
      paymentMethod: 'YAPE',
      issueInvoice: true,
    }).expect(409);
    expect(notConfigured.body.code).toBe('INVOICING_NOT_CONFIGURED');
    expect(await prisma.localSale.count({ where: { barbershopId: shop.shopId } })).toBe(before);

    await o.client
      .put(`${base}/invoicing`, { provider: 'NUBEFACT', enabled: true, series: 'B001' }, o.token)
      .expect(400);
    const config = await o.client
      .put(`${base}/invoicing`, { provider: 'FAKE', enabled: true, series: 'B001' }, o.token)
      .expect(200);
    expect(config.body).toEqual({
      provider: 'FAKE',
      enabled: true,
      series: 'B001',
      nextNumber: 1,
      hasCredentials: false,
    });

    const invoiced = await sale(shop, {
      lines: [{ serviceId: shop.serviceId }],
      paymentMethod: 'CARD',
      issueInvoice: true,
      customer: { type: 'DNI', number: '12345678', name: 'Ana Pérez' },
    }).expect(201);
    expect(invoiced.body.invoice).toMatchObject({
      number: 'B001-00000001',
      status: 'ISSUED',
      totalAmount: 2500,
      taxAmount: 381,
    });
    expect(invoiced.body.invoice.pdfUrl).toContain('B001-00000001');
    // Desde S/ 700 la boleta identifica al comprador.
    await sale(shop, {
      lines: [{ description: 'Paquete novio', unitAmount: 80000 }],
      paymentMethod: 'CARD',
      issueInvoice: true,
    }).expect(400);

    const voided = await o.client
      .post(`${base}/sales/${first.body.id}/void`, { reason: 'Error de cobro' }, o.token)
      .expect(200);
    expect(voided.body).toMatchObject({ status: 'VOIDED', voidReason: 'Error de cobro' });
    const twice = await o.client
      .post(`${base}/sales/${first.body.id}/void`, { reason: 'Otra vez' }, o.token)
      .expect(409);
    expect(twice.body.code).toBe('SALE_ALREADY_VOIDED');

    await sale(shop, { lines: [{ serviceId: shop.serviceId }], paymentMethod: 'CASH' }).expect(201);
    const closed = await o.client
      .post(`${base}/cash/close`, { countedAmount: 12000, note: 'Faltó cambio' }, o.token)
      .expect(200);
    expect(closed.body).toMatchObject({
      expectedAmount: 12500,
      countedAmount: 12000,
      difference: -500,
    });
    await o.client.post(`${base}/cash/close`, { countedAmount: 0 }, o.token).expect(409);
    const history = await o.client.get(`${base}/cash/history`, o.token).expect(200);
    expect(history.body).toHaveLength(1);
    expect((await o.client.get(`${base}/cash`, o.token).expect(200)).body).toEqual({});

    const today = await o.client.get(`${base}/sales`, o.token).expect(200);
    expect(today.body).toHaveLength(3);
    const one = await o.client.get(`${base}/sales/${invoiced.body.id}`, o.token).expect(200);
    expect(one.body.invoice.status).toBe('ISSUED');
    await o.client.post(`${base}/sales/${invoiced.body.id}/invoice/retry`, {}, o.token).expect(200);
  });

  it('ranking: reservas atendidas y ventas suman; promoción solo para un nivel', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const base = `${API}/barbershops/${shop.shopId}`;
    const loyal = await kit.verified();
    await kit.attended(shop, lima(MONDAY, '10:00'), loyal);
    clock.current = lima(MONDAY, '08:00');

    // Venta en el local al mismo cliente (vinculado por su usuario).
    const username = (await prisma.user.findUniqueOrThrow({ where: { id: loyal.userId } }))
      .username;
    const client = await o.client.post(`${base}/clients`, { username }, o.token).expect(201);
    await sale(shop, {
      shopClientId: client.body.id,
      lines: [{ serviceId: shop.serviceId }],
      paymentMethod: 'YAPE',
    }).expect(201);

    const ranking = await o.client
      .post(`${base}/clients/ranking/recompute`, {}, o.token)
      .expect(200);
    const me = ranking.body.top.find((c: { id: string }) => c.id === client.body.id);
    // 2 visitas (20) + S/ 50 gastados (5) = 25 puntos: Bronce (Plata desde 50).
    expect(me).toMatchObject({ visitsCount: 2, score: 25, tier: 'BRONZE' });
    expect(ranking.body.tiers.find((t: { tier: string }) => t.tier === 'BRONZE').count).toBe(1);
    const detail = await o.client.get(`${base}/clients/${client.body.id}`, o.token).expect(200);
    expect(detail.body.visits.map((v: { source: string }) => v.source).sort()).toEqual([
      'BOOKING',
      'SALE',
    ]);

    // Promoción solo para Bronce o más.
    await o.client
      .post(
        `${base}/promotions`,
        { name: 'Clientes bronce', type: 'PERCENTAGE', value: 20, minTier: 'BRONZE' },
        o.token,
      )
      .expect(201);
    const quote = (who: { client: AuthClient; token: string }) =>
      who.client
        .post(
          `${API}/bookings/quote`,
          {
            barbershopId: shop.shopId,
            serviceId: shop.serviceId,
            startAt: new Date(lima(MONDAY, '15:00')).toISOString(),
          },
          who.token,
        )
        .expect(200);
    expect((await quote(loyal)).body.discountTotal.amount).toBe(500);
    const stranger = await kit.verified();
    expect((await quote(stranger)).body.discountTotal.amount).toBe(0);
    const list = await o.client.get(`${base}/promotions`, o.token).expect(200);
    expect(list.body[0].minTier).toBe('BRONZE');
  });

  it('catálogo: corte desde la foto de un barbero, con estilo y portada', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const base = `${API}/barbershops/${shop.shopId}`;
    const fade = (
      await prisma.serviceStyle.findFirstOrThrow({ where: { category: { key: 'haircut' } } })
    ).id;
    const photo = await sharp({
      create: { width: 900, height: 900, channels: 3, background: '#553322' },
    })
      .jpeg()
      .toBuffer();
    const upload = await o.client.http
      .post(`${base}/barbers/${shop.barberId}/gallery`)
      .set('X-Forwarded-For', o.client.ip)
      .set('Authorization', `Bearer ${o.token}`)
      .field('consent', 'true')
      .field('styleIds', fade)
      .field('faceLength', '140')
      .field('foreheadWidth', '92')
      .field('cheekboneWidth', '100')
      .field('jawWidth', '80')
      .attach('file', photo, { filename: 'corte.jpg', contentType: 'image/jpeg' })
      .expect(201);
    const image = await prisma.image.findUniqueOrThrow({ where: { id: upload.body.id } });
    expect(image.faceShape).toBe('OVAL');
    expect(image.labelConfirmed).toBe(false);
    expect(image.faceRatioLength).toBeCloseTo(1.4, 3);

    const sources = await o.client.get(`${base}/catalog/sources`, o.token).expect(200);
    expect(sources.body.map((s: { imageId: string }) => s.imageId)).toContain(upload.body.id);
    const catalog = await o.client
      .post(
        `${base}/catalog/import`,
        { imageId: upload.body.id, priceAmount: 3500, durationMinutes: 45 },
        o.token,
      )
      .expect(201);
    const item = catalog.body.find((c: { coverUrl: string | null }) => c.coverUrl);
    expect(item).toMatchObject({
      priceAmount: 3500,
      durationMinutes: 45,
      fromBarberName: 'Carlos',
    });
    expect(item.styleKey).toBeTruthy();
    const cleared = await o.client
      .patch(`${base}/catalog/${item.id}`, { styleKey: null, coverImageId: null }, o.token)
      .expect(200);
    expect(cleared.body.find((c: { id: string }) => c.id === item.id)).toMatchObject({
      styleKey: null,
      coverUrl: null,
    });
    await o.client
      .post(
        `${base}/catalog/import`,
        { imageId: randomUUID(), priceAmount: 3500, durationMinutes: 45 },
        o.token,
      )
      .expect(400);

    // Medidas incompletas: 400.
    await o.client.http
      .post(`${base}/barbers/${shop.barberId}/gallery`)
      .set('X-Forwarded-For', o.client.ip)
      .set('Authorization', `Bearer ${o.token}`)
      .field('consent', 'true')
      .field('faceLength', '140')
      .attach('file', photo, { filename: 'corte.jpg', contentType: 'image/jpeg' })
      .expect(400);
  });

  it('reportes: app y local, por barbero con comisión, por medio de pago y CSV', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const base = `${API}/barbershops/${shop.shopId}`;
    await kit.attended(shop, lima(MONDAY, '11:00'));
    await o.client
      .put(`${base}/barbers/${shop.barberId}/commission`, { commissionBp: 4000 }, o.token)
      .expect(200);
    await sale(shop, {
      barberId: shop.barberId,
      lines: [{ serviceId: shop.serviceId }],
      paymentMethod: 'YAPE',
    }).expect(201);

    const range = `from=${new Date(lima(MONDAY, '00:00')).toISOString()}&to=${new Date(lima('2030-01-08', '00:00')).toISOString()}`;
    const report = await o.client.get(`${base}/reports/sales?${range}`, o.token).expect(200);
    expect(report.body).toMatchObject({
      appAmount: 2500,
      localAmount: 2500,
      totalAmount: 5000,
      count: 2,
      averageTicket: 2500,
      full: true,
    });
    expect(report.body.byBarber[0]).toMatchObject({
      barberId: shop.barberId,
      count: 2,
      amount: 5000,
      commissionAmount: 2000,
    });
    expect(report.body.byMethod).toEqual([{ method: 'YAPE', amount: 2500, count: 1 }]);
    expect(report.body.byDay).toHaveLength(1);

    const csv = await o.client.get(`${base}/reports/sales.csv?${range}`, o.token).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('dia,app_soles,local_soles,atenciones');
    await o.client
      .get(
        `${base}/reports/sales?from=${new Date(lima(MONDAY, '10:00')).toISOString()}&to=${new Date(lima(MONDAY, '09:00')).toISOString()}`,
        o.token,
      )
      .expect(400);
  });

  it('caras parecidas e interacciones (forma de cara, etapa 2)', async () => {
    const shop = await kit.shopReady();
    const fade = (
      await prisma.serviceStyle.findFirstOrThrow({ where: { category: { key: 'haircut' } } })
    ).id;
    const photo = await sharp({
      create: { width: 900, height: 900, channels: 3, background: '#223355' },
    })
      .jpeg()
      .toBuffer();
    const o = shop.owner;
    const upload = await o.client.http
      .post(`${API}/barbershops/${shop.shopId}/barbers/${shop.barberId}/gallery`)
      .set('X-Forwarded-For', o.client.ip)
      .set('Authorization', `Bearer ${o.token}`)
      .field('consent', 'true')
      .field('styleIds', fade)
      .field('faceShape', 'ROUND')
      .field('faceLength', '108')
      .field('foreheadWidth', '92')
      .field('cheekboneWidth', '100')
      .field('jawWidth', '86')
      .attach('file', photo, { filename: 'redondo.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(
      (await prisma.image.findUniqueOrThrow({ where: { id: upload.body.id } })).labelConfirmed,
    ).toBe(true);
    const location = await prisma.barbershop.findUniqueOrThrow({
      where: { id: shop.shopId },
      select: { latitude: true, longitude: true },
    });

    const similar = await new AuthClient(app)
      .post(`${API}/recommendations/similar-faces`, {
        measurements: { faceLength: 110, foreheadWidth: 92, cheekboneWidth: 100, jawWidth: 86 },
        lat: location.latitude,
        lng: location.longitude,
        radiusKm: 1,
      })
      .expect(200);
    const hit = similar.body.find((p: { id: string }) => p.id === upload.body.id);
    expect(hit).toMatchObject({ faceShape: 'ROUND', confirmed: true, sameFaceShape: true });
    expect(hit.similarity).toBeGreaterThan(0.9);
    await new AuthClient(app)
      .post(`${API}/recommendations/similar-faces`, {
        measurements: { faceLength: 1, foreheadWidth: 92, cheekboneWidth: 100, jawWidth: 86 },
        lat: 0,
        lng: 0,
      })
      .expect(400);

    const person = await kit.verified();
    const interaction = (body: Record<string, unknown>, status = 204) =>
      person.client.post(`${API}/recommendations/interactions`, body, person.token).expect(status);
    await interaction({ imageId: upload.body.id, kind: 'VIEW' });
    await interaction({ imageId: upload.body.id, kind: 'VIEW' });
    await interaction({ imageId: upload.body.id, kind: 'SAVE' });
    const style = await prisma.serviceStyle.findUniqueOrThrow({ where: { id: fade } });
    await interaction({ styleKey: style.key, kind: 'BOOK' });
    await interaction({ kind: 'VIEW' }, 400);
    await interaction({ styleKey: 'no-existe', kind: 'VIEW' }, 400);
    await interaction({ imageId: randomUUID(), kind: 'VIEW' }, 400);
    expect(await prisma.styleInteraction.count({ where: { userId: person.userId } })).toBe(3);
    await new AuthClient(app)
      .post(`${API}/recommendations/interactions`, { styleKey: style.key, kind: 'VIEW' })
      .expect(401);
  });
});
