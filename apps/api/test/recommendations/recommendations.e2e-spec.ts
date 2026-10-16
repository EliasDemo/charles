import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { ImagesService } from '../../src/modules/images/images.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { staffToken } from '../support/mfa';

/** Recomendación por forma de cara (Etapa 1). */
describe('Recomendación por forma de cara (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
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
    kit = bookingKit(app, clock);
    jpeg = await sharp({ create: { width: 500, height: 600, channels: 3, background: '#553322' } })
      .jpeg()
      .toBuffer();
  });
  afterAll(() => app.close());

  /** Punto propio de la prueba (lejos de las demás barberías de prueba). */
  const spot = () => ({
    lat: -15 - Math.random() * 3,
    lng: -72 - Math.random() * 3,
  });

  async function shopAt(point: { lat: number; lng: number }) {
    const shop = await kit.shopReady();
    await prisma.$executeRaw`
      UPDATE barbershops SET latitude = ${point.lat}, longitude = ${point.lng}
       WHERE id = ${shop.shopId}::uuid`;
    return shop;
  }

  const styleId = async (key: string) =>
    (await prisma.serviceStyle.findUniqueOrThrow({ where: { key } })).id;

  it('clasifica la forma de cara con 4 medidas y rechaza medidas imposibles', async () => {
    const visitor = new AuthClient(app);
    const res = await visitor
      .post(`${API}/face-shape/classify`, {
        faceLength: 140,
        foreheadWidth: 92,
        cheekboneWidth: 100,
        jawWidth: 80,
      })
      .expect(200);
    expect(res.body).toMatchObject({ shape: 'OVAL', confidence: expect.any(Number) });
    const bad = await visitor
      .post(`${API}/face-shape/classify`, {
        faceLength: 900,
        foreheadWidth: 92,
        cheekboneWidth: 100,
        jawWidth: 80,
      })
      .expect(400);
    expect(bad.body.details).toEqual([{ field: 'measurements', constraints: ['plausibleFace'] }]);
  });

  it('cortes compatibles, fotos de caras parecidas cerca y ranking del barbero en ese corte', async () => {
    const point = spot();
    const shop = await shopAt(point);
    // El dueño también es barbero: su vínculo queda enlazado a su perfil profesional.
    const me = await shop.owner.client
      .post(`${API}/barbershops/${shop.shopId}/barbers/me`, {}, shop.owner.token)
      .expect(201);
    const barberId = me.body.id as string;
    await shop.owner.client
      .put(
        `${API}/barbershops/${shop.shopId}/barbers/${barberId}/services`,
        { serviceIds: [shop.serviceId] },
        shop.owner.token,
      )
      .expect(200);
    const fade = await styleId('fade_low');
    const upload = (faceShape: string) =>
      shop.owner.client.http
        .post(`${API}/barbershops/${shop.shopId}/barbers/${barberId}/gallery`)
        .set('X-Forwarded-For', shop.owner.client.ip)
        .set('Authorization', `Bearer ${shop.owner.token}`)
        .field('consent', 'true')
        .field('styleIds', fade)
        .field('faceShape', faceShape)
        .attach('file', jpeg, { filename: 'corte.jpg', contentType: 'image/jpeg' });
    for (const shape of ['OVAL', 'OVAL', 'OVAL', 'ROUND']) {
      const res = await upload(shape).expect(201);
      expect(res.body).toMatchObject({ faceShape: shape, labelConfirmed: true, isDemo: false });
    }
    // Una reserva de ese corte, atendida y valorada con 5 estrellas.
    const client = await kit.verified();
    const booking = await kit.attended({ ...shop, barberId }, lima(MONDAY, '10:00'), client);
    await prisma.booking.update({ where: { id: booking.id }, data: { styleId: fade } });
    await client.client
      .post(`${API}/bookings/${booking.id}/review`, { rating: 5 }, client.token)
      .expect(201);

    const res = await new AuthClient(app)
      .post(`${API}/recommendations/haircuts`, { faceShape: 'OVAL', ...point, radiusKm: 1 })
      .expect(200);
    expect(res.body.faceShape).toEqual({ shape: 'OVAL', confidence: 1, alternatives: [] });
    expect(res.body.disclaimer).toContain('sugerencia');
    expect(res.body.haircuts.length).toBeLessThanOrEqual(5);
    const first = res.body.haircuts[0];
    expect(first).toMatchObject({
      style: { key: 'fade_low' },
      compatibility: 85,
      ruleValidated: false,
      maintenance: 'MEDIUM',
    });
    expect(first.photos).toHaveLength(4);
    expect(first.photos.slice(0, 3).every((p: { sameFaceShape: boolean }) => p.sameFaceShape)).toBe(
      true,
    );
    expect(first.photos[3]).toMatchObject({ faceShape: 'ROUND', sameFaceShape: false });
    expect(first.barbers[0]).toMatchObject({
      barberId,
      barbershopId: shop.shopId,
      confirmedWorks: 4,
      sameShapeWorks: 3,
      styleRatingAverage: 5,
      styleRatingCount: 1,
    });
    expect(first.barbers[0].summary).toMatch(
      /^3 trabajos de este corte en caras ovaladas · 5,0 ★ · a \d+ m$/,
    );
    // Fuera del radio: sin fotos ni barberos.
    const far = await new AuthClient(app)
      .post(`${API}/recommendations/haircuts`, {
        faceShape: 'OVAL',
        lat: -5,
        lng: -80,
        radiusKm: 1,
      })
      .expect(200);
    expect(far.body.haircuts[0].photos).toEqual([]);
    expect(far.body.haircuts[0].barbers).toEqual([]);
  });

  it('fotos de demostración: marcadas como ejemplo, nunca confirmadas y borrables', async () => {
    const point = spot();
    const shop = await shopAt(point);
    const images = app.get(ImagesService);
    const fade = await styleId('fade_low');
    const id = await images.createDemoImage({
      file: jpeg,
      barbershopId: shop.shopId,
      uploadedById: shop.owner.userId,
      styleIds: [fade],
      caption: 'Ejemplo: Degradado bajo',
      source: { provider: 'pexels', id: 123, photographer: 'Ana' },
    });
    const row = await prisma.image.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ isDemo: true, labelConfirmed: false, kind: 'GALLERY' });
    const res = await new AuthClient(app)
      .post(`${API}/recommendations/haircuts`, { faceShape: 'OVAL', ...point, radiusKm: 1 })
      .expect(200);
    const photo = res.body.haircuts[0].photos.find((p: { id: string }) => p.id === id);
    expect(photo).toMatchObject({ isDemo: true, confirmed: false });
    // No cuenta para el ranking de barberos.
    expect(res.body.haircuts[0].barbers).toEqual([]);
    // Una foto de demo no puede quedar confirmada (restricción de la base).
    await expect(
      prisma.image.update({ where: { id }, data: { labelConfirmed: true } }),
    ).rejects.toThrow();
    expect(await images.deleteDemoImages()).toBeGreaterThanOrEqual(1);
    expect((await prisma.image.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
  });

  it('preferencias: el tipo de cabello descarta cortes; sin forma ni medidas, 400', async () => {
    const point = spot();
    const coily = await new AuthClient(app)
      .post(`${API}/recommendations/haircuts`, { faceShape: 'ROUND', hairType: 'COILY', ...point })
      .expect(200);
    const keys = coily.body.haircuts.map((h: { style: { key: string } }) => h.style.key);
    expect(keys).not.toContain('pompadour'); // no funciona con cabello afro
    const res = await new AuthClient(app)
      .post(`${API}/recommendations/haircuts`, { ...point })
      .expect(400);
    expect(res.body.details).toEqual([
      { field: 'faceShape', constraints: ['faceShapeOrMeasurements'] },
    ]);
    // Con medidas: se clasifican en la misma petición.
    const measured = await new AuthClient(app)
      .post(`${API}/recommendations/haircuts`, {
        measurements: { faceLength: 165, foreheadWidth: 95, cheekboneWidth: 100, jawWidth: 90 },
        ...point,
      })
      .expect(200);
    expect(measured.body.faceShape.shape).toBe('OBLONG');
    expect(measured.body.haircuts[0].style.key).not.toBe('pompadour');
  });

  it('recordar mi forma de cara exige consentimiento; luego la recomendación la usa', async () => {
    const me = await kit.verified();
    const denied = await me.client
      .patch(`${API}/users/me`, { faceShape: 'SQUARE' }, me.token)
      .expect(400);
    expect(denied.body.details).toEqual([{ field: 'faceShapeConsent', constraints: ['isTrue'] }]);
    const saved = await me.client
      .patch(`${API}/users/me`, { faceShape: 'SQUARE', faceShapeConsent: true }, me.token)
      .expect(200);
    expect(saved.body.faceShape).toBe('SQUARE');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.userId } });
    expect(row.faceShapeConsentAt).not.toBeNull();

    const res = await me.client
      .post(`${API}/recommendations/haircuts`, { ...spot() }, me.token)
      .expect(200);
    expect(res.body.faceShape.shape).toBe('SQUARE');

    const cleared = await me.client
      .patch(`${API}/users/me`, { faceShape: null }, me.token)
      .expect(200);
    expect(cleared.body.faceShape).toBeNull();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: me.userId } });
    expect(after.faceShapeConsentAt).toBeNull();
  });

  it('la reserva guarda el corte elegido; un estilo inexistente es 400', async () => {
    const shop = await kit.shopReady();
    const client = await kit.verified();
    const book = (style: string) =>
      client.client
        .post(
          `${API}/bookings`,
          {
            barbershopId: shop.shopId,
            serviceId: shop.serviceId,
            startAt: new Date(lima(MONDAY, '11:00')).toISOString(),
            barberId: shop.barberId,
            styleId: style,
          },
          client.token,
        )
        .set('Idempotency-Key', randomUUID());
    const bad = await book(randomUUID()).expect(400);
    expect(bad.body.details).toEqual([{ field: 'styleId', constraints: ['activeStyle'] }]);
    const fade = await styleId('fade_mid');
    const ok = await book(fade).expect(201);
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect(row.styleId).toBe(fade);
  });

  it('catálogo ampliado y matriz editable solo por ADMIN, con auditoría', async () => {
    const styles = await new AuthClient(app)
      .get(`${API}/service-styles?category=haircut`)
      .expect(200);
    const quiff = styles.body.find((s: { key: string }) => s.key === 'quiff');
    expect(quiff).toMatchObject({
      maintenance: 'HIGH',
      vibe: 'MODERN',
      hairTypes: ['STRAIGHT', 'WAVY'],
    });
    expect(quiff.description).toEqual(expect.any(String));

    const boss: Person = await kit.verified();
    await prisma.userRole.create({ data: { userId: boss.userId, role: 'ADMIN' } });
    boss.token = await staffToken(app, boss);
    const rules = await boss.client.get(`${API}/admin/face-shape-rules`, boss.token).expect(200);
    expect(rules.body.length).toBeGreaterThanOrEqual(90);
    const mullet = await styleId('mullet');
    const before = rules.body.find(
      (r: { styleId: string; faceShape: string }) =>
        r.styleId === mullet && r.faceShape === 'HEART',
    );
    const updated = await boss.client
      .put(
        `${API}/admin/face-shape-rules`,
        {
          faceShape: 'HEART',
          styleId: mullet,
          score: 72,
          validated: true,
          reason: 'Revisado con barberos',
        },
        boss.token,
      )
      .expect(200);
    expect(updated.body).toMatchObject({ score: 72, validated: true, styleKey: 'mullet' });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'face_shape_rule.updated', entityId: updated.body.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.changes).toMatchObject({ reason: 'Revisado con barberos', score: { to: 72 } });
    // Se restaura para no afectar a otras pruebas.
    await prisma.faceShapeRule.update({
      where: { id: updated.body.id },
      data: { score: before.score, validated: false },
    });

    const shop = await kit.shopReady();
    await shop.owner.client.get(`${API}/admin/face-shape-rules`, shop.owner.token).expect(403);
    await boss.client
      .put(
        `${API}/admin/face-shape-rules`,
        { faceShape: 'HEART', styleId: mullet, score: 120, reason: 'Fuera de rango' },
        boss.token,
      )
      .expect(400);
  });
});
