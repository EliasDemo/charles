import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { ImageRateLimitRefresher } from '../../src/modules/images/image-rate-limit';
import { IMAGE_STORAGE, type ImageStorage } from '../../src/modules/images/image-storage';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { shopPayload } from '../support/barbershops';
import {
  API,
  bookingKit,
  type BookingKit,
  type KitShop,
  lima,
  MONDAY,
  type Person,
} from '../support/bookings';
import { staffToken } from '../support/mfa';

const SHOPS = `${API}/barbershops`;

/** JPEG "de celular": EXIF con fabricante y GPS. */
async function phoneJpeg(width = 1200, height = 900): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 60, b: 30 } } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TelefonoX', Model: 'Prueba' },
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '12/1 2/1 3/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '77/1 1/1 2/1',
      },
    })
    .toBuffer();
}

describe('Imágenes y galería (e2e, Fase 14)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let storage: ImageStorage;
  let kit: BookingKit;
  let jpeg: Buffer;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    storage = app.get(IMAGE_STORAGE);
    kit = bookingKit(app, clock);
    jpeg = await phoneJpeg();
  });
  afterAll(() => app.close());

  /** charles_test no siembra ajustes: se crean para la prueba y se borran al terminar. */
  async function withSettings(values: Record<string, unknown>, run: () => Promise<void>) {
    const keys = Object.keys(values);
    await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    for (const [key, value] of Object.entries(values)) {
      await prisma.appSetting.create({ data: { key, value: value as never } });
    }
    try {
      await run();
    } finally {
      await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    }
  }

  async function person(): Promise<Person> {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    return { client, token: tokens.accessToken, userId: tokens.user.id, email };
  }

  /** Subida multipart. `fields`: campos de texto adicionales. */
  function upload(
    who: { client: AuthClient; token: string },
    method: 'put' | 'post',
    path: string,
    file: Buffer | null,
    fields: Record<string, string> = {},
    filename = 'foto.jpg',
  ) {
    let req = who.client.http[method](path)
      .set('X-Forwarded-For', who.client.ip)
      .set('Authorization', `Bearer ${who.token}`);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    if (file) req = req.attach('file', file, { filename, contentType: 'image/jpeg' });
    return req;
  }

  const styleId = async (key: string) =>
    (await prisma.serviceStyle.findUniqueOrThrow({ where: { key } })).id;

  const gallery = (shop: KitShop, fields: Record<string, string> = { consent: 'true' }) =>
    upload(
      shop.owner,
      'post',
      `${SHOPS}/${shop.shopId}/barbers/${shop.barberId}/gallery`,
      jpeg,
      fields,
    );

  it('portada: sin EXIF ni GPS, en WebP, servida por la API y visible en la barbería', async () => {
    const shop = await kit.shopReady();
    const res = await upload(shop.owner, 'put', `${SHOPS}/${shop.shopId}/cover`, jpeg).expect(200);
    expect(res.body).toEqual({
      logoUrl: null,
      coverUrl: expect.stringMatching(/^\/api\/v1\/media\/img\/[A-Za-z0-9_-]{22}\/large\.webp$/),
      coverThumbUrl: expect.stringMatching(/\/thumb\.webp$/),
    });
    const file = await new AuthClient(app).get(res.body.coverUrl as string).expect(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect(file.headers['cache-control']).toContain('immutable');
    const meta = await sharp(file.body as Buffer).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 1200, height: 900 });
    expect(meta.exif).toBeUndefined();
    expect((file.body as Buffer).toString('latin1')).not.toContain('TelefonoX');

    const publicView = await new AuthClient(app).get(`${SHOPS}/${shop.shopId}`).expect(200);
    expect(publicView.body).toMatchObject({
      coverUrl: res.body.coverUrl,
      coverThumbUrl: res.body.coverThumbUrl,
      logoUrl: null,
    });

    // Reemplazo: el archivo anterior se borra.
    const replaced = await upload(shop.owner, 'put', `${SHOPS}/${shop.shopId}/cover`, jpeg).expect(
      200,
    );
    expect(replaced.body.coverUrl).not.toBe(res.body.coverUrl);
    await new AuthClient(app).get(res.body.coverUrl as string).expect(404);
    expect(
      await prisma.image.count({
        where: { barbershopId: shop.shopId, kind: 'BARBERSHOP_COVER', deletedAt: null },
      }),
    ).toBe(1);

    // Quitar.
    const removed = await shop.owner.client
      .delete(`${SHOPS}/${shop.shopId}/cover`, shop.owner.token)
      .expect(200);
    expect(removed.body.coverUrl).toBeNull();
    await new AuthClient(app).get(replaced.body.coverUrl as string).expect(404);
  });

  it('logo: cuadrado de 512; un no miembro recibe 404', async () => {
    const shop = await kit.shopReady();
    const res = await upload(shop.owner, 'put', `${SHOPS}/${shop.shopId}/logo`, jpeg).expect(200);
    const file = await new AuthClient(app).get(res.body.logoUrl as string).expect(200);
    expect(await sharp(file.body as Buffer).metadata()).toMatchObject({ width: 512, height: 512 });
    const stranger = await person();
    await upload(stranger, 'put', `${SHOPS}/${shop.shopId}/logo`, jpeg).expect(404);
  });

  it('rechaza un tipo falso, un formato no admitido y la falta de archivo', async () => {
    const shop = await kit.shopReady();
    const fake = Buffer.from('esto no es una imagen, aunque se llame foto.jpg');
    const bad = await upload(shop.owner, 'put', `${SHOPS}/${shop.shopId}/cover`, fake).expect(400);
    expect(bad.body.code).toBe('INVALID_IMAGE');
    const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
      .gif()
      .toBuffer();
    const gifRes = await upload(shop.owner, 'put', `${SHOPS}/${shop.shopId}/logo`, gif).expect(400);
    expect(gifRes.body.code).toBe('INVALID_IMAGE');
    await upload(shop.owner, 'put', `${SHOPS}/${shop.shopId}/cover`, null).expect(400);
    expect(await prisma.image.count({ where: { barbershopId: shop.shopId } })).toBe(0);
  });

  it('rechaza archivos de más de 10 MB con 413', async () => {
    const shop = await kit.shopReady();
    const big = Buffer.alloc(10 * 1024 * 1024 + 10, 1);
    await upload(shop.owner, 'put', `${SHOPS}/${shop.shopId}/cover`, big).expect(413);
  });

  it('la portada cumple el requisito PHOTO del envío a revisión', async () => {
    await withSettings(
      { 'barbershops.require_review': true, 'barbershops.require_photo': true },
      async () => {
        const owner = await person();
        const created = await owner.client
          .post(
            SHOPS,
            { ...shopPayload(), ownerDocument: { type: 'DNI', number: '12345678' } },
            owner.token,
          )
          .expect(201);
        const id = created.body.id as string;
        const review = async () =>
          (await owner.client.get(`${SHOPS}/${id}/review`, owner.token).expect(200)).body;
        expect((await review()).missingRequirements).toEqual(['PHOTO']);
        await upload(owner, 'put', `${SHOPS}/${id}/cover`, jpeg).expect(200);
        expect(await review()).toMatchObject({ missingRequirements: [], canSubmit: true });
        await owner.client.post(`${SHOPS}/${id}/review/submit`, {}, owner.token).expect(200);
      },
    );
  });

  it('foto del barbero, especialidades y años: visibles en el perfil público', async () => {
    const shop = await kit.shopReady();
    const photo = await upload(
      shop.owner,
      'put',
      `${SHOPS}/${shop.shopId}/barbers/${shop.barberId}/photo`,
      jpeg,
    ).expect(200);
    expect(photo.body.photoUrl).toMatch(/\/square\.webp$/);

    const [fade, beard] = [await styleId('fade_low'), await styleId('beard_full')];
    await shop.owner.client
      .put(
        `${SHOPS}/${shop.shopId}/barbers/${shop.barberId}/specialties`,
        { styleIds: [beard, fade] },
        shop.owner.token,
      )
      .expect(204);
    await shop.owner.client
      .patch(
        `${SHOPS}/${shop.shopId}/barbers/${shop.barberId}`,
        { yearsExperience: 7 },
        shop.owner.token,
      )
      .expect(200);
    const six = await prisma.serviceStyle.findMany({ take: 6, select: { id: true } });
    await shop.owner.client
      .put(
        `${SHOPS}/${shop.shopId}/barbers/${shop.barberId}/specialties`,
        { styleIds: six.map((s) => s.id) },
        shop.owner.token,
      )
      .expect(400);

    const list = await new AuthClient(app).get(`${SHOPS}/${shop.shopId}/barbers`).expect(200);
    expect(list.body.items[0]).toMatchObject({
      photoUrl: photo.body.photoUrl,
      yearsExperience: 7,
      specialties: [
        { id: fade, key: 'fade_low', name: 'Degradado bajo' },
        { id: beard, key: 'beard_full', name: 'Barba completa' },
      ],
    });
  });

  it('galería: consentimiento obligatorio, estilos, servicio para reservar, filtros y destacadas', async () => {
    const shop = await kit.shopReady();
    const noConsent = await gallery(shop, {}).expect(400);
    expect(noConsent.body.code).toBe('VALIDATION_ERROR');
    await gallery(shop, { consent: 'false' }).expect(400);

    const fade = await styleId('fade_low');
    const first = await gallery(shop, {
      consent: 'true',
      caption: 'Degradado clásico',
      styleIds: fade,
      serviceId: shop.serviceId,
    }).expect(201);
    expect(first.body).toMatchObject({
      barberId: shop.barberId,
      barberName: 'Carlos',
      caption: 'Degradado clásico',
      styles: [{ id: fade, key: 'fade_low' }],
      service: {
        id: shop.serviceId,
        name: 'Corte',
        price: { amount: 2500, currency: 'PEN' },
        durationMinutes: 30,
      },
      pinned: false,
      openReports: 0,
      hidden: false,
    });
    const image = await prisma.image.findUniqueOrThrow({ where: { id: first.body.id as string } });
    expect(image).toMatchObject({ consentGiven: true, consentByUserId: shop.owner.userId });
    expect(image.consentTimestamp).not.toBeNull();
    const second = await gallery(shop).expect(201);

    const pub = (query = '') =>
      new AuthClient(app).get(`${SHOPS}/${shop.shopId}/gallery${query}`).expect(200);
    expect((await pub()).body.items.map((i: { id: string }) => i.id)).toEqual([
      second.body.id,
      first.body.id,
    ]);
    expect((await pub('?style=fade_low')).body.items.map((i: { id: string }) => i.id)).toEqual([
      first.body.id,
    ]);
    await new AuthClient(app).get(`${SHOPS}/${shop.shopId}/gallery?style=no_existe`).expect(400);

    // Destacar: aparte, solo en la primera página.
    await shop.owner.client
      .patch(`${SHOPS}/${shop.shopId}/gallery/${first.body.id}`, { pinned: true }, shop.owner.token)
      .expect(200);
    const pinned = (await pub()).body;
    expect(pinned.pinned.map((i: { id: string }) => i.id)).toEqual([first.body.id]);
    expect(pinned.items.map((i: { id: string }) => i.id)).toEqual([second.body.id]);
    await withSettings({ 'images.pinned_max_per_barber': 1 }, async () => {
      const full = await shop.owner.client
        .patch(
          `${SHOPS}/${shop.shopId}/gallery/${second.body.id}`,
          { pinned: true },
          shop.owner.token,
        )
        .expect(409);
      expect(full.body.code).toBe('IMAGE_LIMIT_REACHED');
    });

    // Paginación.
    const page1 = (await pub('?limit=1')).body;
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeNull();

    // Límite de la galería.
    await withSettings({ 'images.gallery_max_per_barber': 2 }, async () => {
      const full = await gallery(shop).expect(409);
      expect(full.body.code).toBe('IMAGE_LIMIT_REACHED');
    });

    // Búsqueda por estilo.
    const search = await new AuthClient(app)
      .get(`${API}/search/barbershops?style=fade_low&limit=50`)
      .expect(200);
    const found = search.body.items.find((i: { id: string }) => i.id === shop.shopId);
    expect(found).toBeDefined();
    const other = await new AuthClient(app)
      .get(`${API}/search/barbershops?style=kids_design&limit=50`)
      .expect(200);
    expect(other.body.items.find((i: { id: string }) => i.id === shop.shopId)).toBeUndefined();

    // Borrar: también el archivo.
    await shop.owner.client
      .delete(`${SHOPS}/${shop.shopId}/gallery/${second.body.id}`, shop.owner.token)
      .expect(204);
    await new AuthClient(app).get(second.body.largeUrl as string).expect(404);
  });

  it('el propio barbero gestiona su galería; otro barbero de la misma barbería no', async () => {
    const shop = await kit.shopReady();
    const barberUser = await person();
    await prisma.barber.update({
      where: { id: shop.barberId },
      data: { userId: barberUser.userId },
    });
    const own = await upload(
      barberUser,
      'post',
      `${SHOPS}/${shop.shopId}/barbers/${shop.barberId}/gallery`,
      jpeg,
      { consent: 'true' },
    ).expect(201);
    expect(own.body.barberId).toBe(shop.barberId);
    const mine = await barberUser.client
      .get(`${API}/me/barbershops/${shop.shopId}/gallery`, barberUser.token)
      .expect(200);
    expect(mine.body.items).toHaveLength(1);

    const other = await prisma.barber.create({
      data: { barbershopId: shop.shopId, displayName: 'Otro' },
    });
    await upload(barberUser, 'post', `${SHOPS}/${shop.shopId}/barbers/${other.id}/gallery`, jpeg, {
      consent: 'true',
    }).expect(404);
    await barberUser.client
      .get(`${API}/me/barbershops/${shop.shopId}/gallery?barberId=${other.id}`, barberUser.token)
      .expect(403);
  });

  it('reportes: con 3 abiertos se oculta; soporte la mantiene, la retira o la restaura', async () => {
    const shop = await kit.shopReady();
    const img = await gallery(shop).expect(201);
    const id = img.body.id as string;
    const visibleIds = async () =>
      (await new AuthClient(app).get(`${SHOPS}/${shop.shopId}/gallery`).expect(200)).body.items.map(
        (i: { id: string }) => i.id,
      );

    // La barbería no reporta lo suyo.
    await shop.owner.client
      .post(`${API}/gallery/${id}/reports`, { reason: 'OTHER' }, shop.owner.token)
      .expect(403);
    const reporters = [await person(), await person(), await person()];
    for (const [i, r] of reporters.entries()) {
      await r.client
        .post(
          `${API}/gallery/${id}/reports`,
          { reason: 'NO_CONSENT', details: `motivo ${i}` },
          r.token,
        )
        .expect(204);
      expect((await visibleIds()).includes(id)).toBe(i < 2);
    }
    await reporters[0]!.client
      .post(`${API}/gallery/${id}/reports`, { reason: 'OTHER' }, reporters[0]!.token)
      .expect(409);

    const manage = await shop.owner.client
      .get(`${API}/me/barbershops/${shop.shopId}/gallery`, shop.owner.token)
      .expect(200);
    expect(manage.body.items[0]).toMatchObject({
      id,
      openReports: 3,
      hidden: true,
      removed: false,
    });

    const support = await person();
    await prisma.userRole.create({ data: { userId: support.userId, role: 'SUPPORT' } });
    support.token = await staffToken(app, support);
    const queue = await support.client
      .get(`${API}/admin/images/reported`, support.token)
      .expect(200);
    expect(queue.body.items.find((i: { id: string }) => i.id === id)?.reports).toHaveLength(3);

    const keep = await support.client
      .post(
        `${API}/admin/images/${id}/moderation`,
        { decision: 'KEEP', reason: 'Foto propia, revisado' },
        support.token,
      )
      .expect(200);
    expect(keep.body).toMatchObject({ openReports: 0, hidden: false });
    expect(await visibleIds()).toContain(id);

    await support.client
      .post(
        `${API}/admin/images/${id}/moderation`,
        { decision: 'REMOVE', reason: 'Sin consentimiento' },
        support.token,
      )
      .expect(200);
    expect(await visibleIds()).not.toContain(id);
    await support.client
      .post(
        `${API}/admin/images/${id}/moderation`,
        { decision: 'REMOVE', reason: 'Otra vez' },
        support.token,
      )
      .expect(409);
    await support.client
      .post(
        `${API}/admin/images/${id}/moderation`,
        { decision: 'RESTORE', reason: 'Se aclaró el caso' },
        support.token,
      )
      .expect(200);
    expect(await visibleIds()).toContain(id);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'image.uploaded',
        'image.moderation.keep',
        'image.moderation.remove',
        'image.moderation.restore',
      ]),
    );

    // Un cliente no entra a la moderación.
    await reporters[1]!.client.get(`${API}/admin/images/reported`, reporters[1]!.token).expect(403);
  });

  it('estilos: listado público y gestión solo ADMIN', async () => {
    const list = await new AuthClient(app).get(`${API}/service-styles?category=beard`).expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(5);
    expect(list.body.every((s: { categoryKey: string }) => s.categoryKey === 'beard')).toBe(true);

    const support = await person();
    await prisma.userRole.create({ data: { userId: support.userId, role: 'SUPPORT' } });
    support.token = await staffToken(app, support);
    await support.client.get(`${API}/admin/service-styles`, support.token).expect(403);

    const admin = await person();
    await prisma.userRole.create({ data: { userId: admin.userId, role: 'ADMIN' } });
    admin.token = await staffToken(app, admin);
    const category = await prisma.serviceCategory.findUniqueOrThrow({ where: { key: 'beard' } });
    const key = `test_${Date.now().toString(36)}`;
    const created = await admin.client
      .post(
        `${API}/admin/service-styles`,
        { key, name: 'Barba de prueba', categoryId: category.id },
        admin.token,
      )
      .expect(201);
    expect(created.body).toMatchObject({ key, isActive: true, categoryKey: 'beard' });
    await admin.client
      .post(
        `${API}/admin/service-styles`,
        { key, name: 'Repetido', categoryId: category.id },
        admin.token,
      )
      .expect(409);
    await admin.client
      .patch(`${API}/admin/service-styles/${created.body.id}`, { isActive: false }, admin.token)
      .expect(200);
    const after = await new AuthClient(app).get(`${API}/service-styles`).expect(200);
    expect(after.body.find((s: { key: string }) => s.key === key)).toBeUndefined();
    await prisma.serviceStyle.delete({ where: { id: created.body.id as string } });
  });

  it('eliminar la barbería borra sus archivos', async () => {
    const shop = await kit.shopReady();
    const cover = await upload(shop.owner, 'put', `${SHOPS}/${shop.shopId}/cover`, jpeg).expect(
      200,
    );
    const img = await gallery(shop).expect(201);
    await shop.owner.client.delete(`${SHOPS}/${shop.shopId}`, shop.owner.token).expect(204);
    expect(
      await prisma.image.count({ where: { barbershopId: shop.shopId, deletedAt: null } }),
    ).toBe(0);
    for (const url of [
      cover.body.coverUrl,
      cover.body.coverThumbUrl,
      img.body.largeUrl,
      img.body.thumbUrl,
    ]) {
      const key = (url as string).replace('/api/v1/media/', '');
      expect(await storage.get(key)).toBeNull();
    }
  });

  it('edición, quitar foto y logo, datos inválidos y accesos ajenos', async () => {
    const shop = await kit.shopReady();
    const base = `${SHOPS}/${shop.shopId}`;
    const fade = await styleId('fade_low');
    const beard = await styleId('beard_full');

    // Estilos y servicio en multipart: separados por comas o campo repetido.
    const multi = await upload(
      shop.owner,
      'post',
      `${base}/barbers/${shop.barberId}/gallery`,
      jpeg,
      {
        consent: 'true',
        styleIds: `${fade}, ${beard}`,
        caption: '',
        serviceId: '',
      },
    ).expect(201);
    expect(multi.body.styles).toHaveLength(2);
    expect(multi.body).toMatchObject({ caption: null, service: null });
    await upload(shop.owner, 'post', `${base}/barbers/${shop.barberId}/gallery`, jpeg, {
      consent: 'true',
      styleIds: '00000000-0000-7000-8000-000000000000',
    }).expect(400);
    const otherShop = await kit.shopReady();
    await upload(shop.owner, 'post', `${base}/barbers/${shop.barberId}/gallery`, jpeg, {
      consent: 'true',
      serviceId: otherShop.serviceId,
    }).expect(400);
    await upload(
      shop.owner,
      'post',
      `${base}/barbers/00000000-0000-7000-8000-000000000000/gallery`,
      jpeg,
      {
        consent: 'true',
      },
    ).expect(404);

    // Editar: texto, estilos, servicio; quitar el destacado.
    const id = multi.body.id as string;
    const edited = await shop.owner.client
      .patch(
        `${base}/gallery/${id}`,
        { caption: 'Nuevo texto', styleIds: [beard], serviceId: shop.serviceId, pinned: true },
        shop.owner.token,
      )
      .expect(200);
    expect(edited.body).toMatchObject({
      caption: 'Nuevo texto',
      styles: [{ id: beard }],
      service: { id: shop.serviceId },
      pinned: true,
    });
    const unpinned = await shop.owner.client
      .patch(
        `${base}/gallery/${id}`,
        { pinned: false, caption: null, serviceId: null },
        shop.owner.token,
      )
      .expect(200);
    expect(unpinned.body).toMatchObject({ pinned: false, caption: null, service: null });
    await shop.owner.client
      .patch(
        `${base}/gallery/${id}`,
        { styleIds: ['00000000-0000-7000-8000-000000000000'] },
        shop.owner.token,
      )
      .expect(400);
    await shop.owner.client
      .patch(
        `${base}/gallery/00000000-0000-7000-8000-000000000000`,
        { caption: 'x' },
        shop.owner.token,
      )
      .expect(404);

    // Un servicio no disponible no se ofrece para reservar.
    await shop.owner.client
      .patch(`${base}/gallery/${id}`, { serviceId: shop.serviceId }, shop.owner.token)
      .expect(200);
    await prisma.service.update({ where: { id: shop.serviceId }, data: { isAvailable: false } });
    const pub = await new AuthClient(app).get(`${base}/gallery`).expect(200);
    expect(pub.body.items[0].service).toBeNull();

    // Accesos ajenos.
    const stranger = await person();
    await stranger.client
      .get(`${API}/me/barbershops/${shop.shopId}/gallery`, stranger.token)
      .expect(404);
    await stranger.client
      .patch(`${base}/gallery/${id}`, { caption: 'ajeno' }, stranger.token)
      .expect(404);
    await stranger.client
      .put(`${base}/barbers/${shop.barberId}/specialties`, { styleIds: [] }, stranger.token)
      .expect(404);
    await stranger.client
      .post(
        `${API}/gallery/00000000-0000-7000-8000-000000000000/reports`,
        { reason: 'OTHER' },
        stranger.token,
      )
      .expect(404);

    // Gestión con filtros.
    const managed = await shop.owner.client
      .get(
        `${API}/me/barbershops/${shop.shopId}/gallery?barberId=${shop.barberId}&style=beard_full`,
        shop.owner.token,
      )
      .expect(200);
    expect(managed.body.items.map((i: { id: string }) => i.id)).toEqual([id]);

    // Especialidades vacías.
    await shop.owner.client
      .put(`${base}/barbers/${shop.barberId}/specialties`, { styleIds: [] }, shop.owner.token)
      .expect(204);

    // Quitar foto del barbero y logo (también sin tener uno).
    await upload(shop.owner, 'put', `${base}/barbers/${shop.barberId}/photo`, jpeg).expect(200);
    const noPhoto = await shop.owner.client
      .delete(`${base}/barbers/${shop.barberId}/photo`, shop.owner.token)
      .expect(200);
    expect(noPhoto.body).toEqual({ photoUrl: null });
    await shop.owner.client
      .delete(`${base}/barbers/${shop.barberId}/photo`, shop.owner.token)
      .expect(200);
    await shop.owner.client.delete(`${base}/logo`, shop.owner.token).expect(200);
    const barbers = await new AuthClient(app).get(`${base}/barbers`).expect(200);
    expect(barbers.body.items[0].photoUrl).toBeNull();
  });

  it('límite propio de subidas por cuenta', async () => {
    await withSettings({ 'images.upload_rate_limit_per_minute': 1 }, async () => {
      const refresher = app.get(ImageRateLimitRefresher);
      await refresher.refresh();
      try {
        const shop = await kit.shopReady();
        await upload(shop.owner, 'put', `${SHOPS}/${shop.shopId}/logo`, jpeg).expect(200);
        const limited = await upload(
          shop.owner,
          'put',
          `${SHOPS}/${shop.shopId}/logo`,
          jpeg,
        ).expect(429);
        expect(limited.body.code).toBe('TOO_MANY_REQUESTS');
      } finally {
        await prisma.appSetting.deleteMany({
          where: { key: 'images.upload_rate_limit_per_minute' },
        });
        await refresher.refresh();
      }
    });
  });

  it('moderación y estilos: errores y filtros', async () => {
    const support = await person();
    await prisma.userRole.create({ data: { userId: support.userId, role: 'SUPPORT' } });
    support.token = await staffToken(app, support);
    await support.client
      .post(
        `${API}/admin/images/00000000-0000-7000-8000-000000000000/moderation`,
        { decision: 'KEEP', reason: 'No existe' },
        support.token,
      )
      .expect(404);
    const shop = await kit.shopReady();
    const img = await gallery(shop).expect(201);
    await support.client
      .post(
        `${API}/admin/images/${img.body.id}/moderation`,
        { decision: 'RESTORE', reason: 'No estaba retirada' },
        support.token,
      )
      .expect(409);
    const resolved = await support.client
      .get(`${API}/admin/images/reported?status=RESOLVED&limit=1`, support.token)
      .expect(200);
    expect(Array.isArray(resolved.body.items)).toBe(true);

    const admin = await person();
    await prisma.userRole.create({ data: { userId: admin.userId, role: 'ADMIN' } });
    admin.token = await staffToken(app, admin);
    const all = await admin.client.get(`${API}/admin/service-styles`, admin.token).expect(200);
    expect(all.body.length).toBeGreaterThanOrEqual(30);
    await admin.client
      .post(
        `${API}/admin/service-styles`,
        { key: 'sin_categoria', name: 'Nada', categoryId: '00000000-0000-7000-8000-000000000000' },
        admin.token,
      )
      .expect(400);
    await admin.client
      .patch(
        `${API}/admin/service-styles/00000000-0000-7000-8000-000000000000`,
        { name: 'Nada' },
        admin.token,
      )
      .expect(404);
  });

  it('la ruta de imágenes solo sirve claves con el formato de la API', async () => {
    const c = new AuthClient(app);
    await c.get(`${API}/media/img/corta/large.webp`).expect(404);
    await c.get(`${API}/media/img/${'a'.repeat(22)}/otro.png`).expect(404);
    await c.get(`${API}/media/img/${'a'.repeat(22)}/large.webp`).expect(404);
  });
});
