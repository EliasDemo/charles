import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import {
  API,
  bookingKit,
  type BookingKit,
  type KitShop,
  lima,
  MONDAY,
  type Person,
} from '../support/bookings';

/** Carrera del barbero: perfil profesional, bolsa de trabajo, varias barberías y progreso propio. */
describe('Carrera del barbero: perfil, bolsa de trabajo y varias barberías (e2e)', () => {
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
    jpeg = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#335577' } })
      .jpeg()
      .toBuffer();
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
  });
  afterAll(() => app.close());

  const PROFILE = `${API}/me/barber-profile`;

  async function barberWithProfile(name = 'Carlos Fade'): Promise<Person & { profileId: string }> {
    const person = await kit.verified();
    const res = await person.client
      .put(
        PROFILE,
        { displayName: name, district: 'Miraflores', availableForWork: true },
        person.token,
      )
      .expect(200);
    return { ...person, profileId: res.body.id as string };
  }

  /** La barbería publica una oferta, el barbero postula y lo contrata. Devuelve el vínculo. */
  async function hire(shop: KitShop, barber: Person): Promise<string> {
    const posting = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/jobs`,
        {
          title: 'Barbero para fines de semana',
          description: 'Buscamos barbero con experiencia en degradados y barba.',
          employmentType: 'WEEKENDS',
        },
        shop.owner.token,
      )
      .expect(201);
    const application = await barber.client
      .post(
        `${API}/jobs/${posting.body.id}/applications`,
        { message: 'Hola, me interesa.' },
        barber.token,
      )
      .expect(201);
    await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/job-applications/${application.body.id}/decision`,
        { status: 'HIRED' },
        shop.owner.token,
      )
      .expect(200);
    const link = await prisma.barber.findFirstOrThrow({
      where: { barbershopId: shop.shopId, userId: barber.userId, deletedAt: null },
    });
    await shop.owner.client
      .put(
        `${API}/barbershops/${shop.shopId}/barbers/${link.id}/services`,
        { serviceIds: [shop.serviceId] },
        shop.owner.token,
      )
      .expect(200);
    return link.id;
  }

  it('crear y editar el perfil profesional da el rol BARBER; sin perfil, 404', async () => {
    const person = await kit.verified();
    await person.client.get(PROFILE, person.token).expect(404);
    const created = await person.client
      .put(
        PROFILE,
        { displayName: 'Ana Tijeras', headline: 'Colorista', yearsExperience: 6 },
        person.token,
      )
      .expect(200);
    expect(created.body).toMatchObject({
      displayName: 'Ana Tijeras',
      headline: 'Colorista',
      yearsExperience: 6,
      ratingAverage: null,
      ratingCount: 0,
      attendedCount: 0,
      rank: null,
      workplaces: [],
      availableForWork: false,
    });
    const roles = await prisma.userRole.findMany({ where: { userId: person.userId } });
    expect(roles.map((r) => r.role)).toContain('BARBER');

    const style = await prisma.serviceStyle.findFirstOrThrow({ where: { isActive: true } });
    const withSpecialty = await person.client
      .put(`${PROFILE}/specialties`, { styleIds: [style.id] }, person.token)
      .expect(200);
    expect(withSpecialty.body.specialties).toEqual([
      { id: style.id, key: style.key, name: style.name },
    ]);
    await person.client.put(PROFILE, { displayName: 'A' }, person.token).expect(400);

    // Público, sin sesión.
    const pub = await new AuthClient(app)
      .get(`${API}/barber-profiles/${created.body.id}`)
      .expect(200);
    expect(pub.body.displayName).toBe('Ana Tijeras');
  });

  it('foto del perfil profesional: subir, reemplazar y quitar', async () => {
    const barber = await barberWithProfile('Foto Barber');
    const put = () =>
      barber.client.http
        .put(`${PROFILE}/photo`)
        .set('X-Forwarded-For', barber.client.ip)
        .set('Authorization', `Bearer ${barber.token}`)
        .attach('file', jpeg, { filename: 'yo.jpg', contentType: 'image/jpeg' });
    const first = await put().expect(200);
    expect(first.body.photoUrl).toMatch(/square\.webp$/);
    const second = await put().expect(200);
    expect(second.body.photoUrl).not.toBe(first.body.photoUrl);
    const pub = await new AuthClient(app)
      .get(`${API}/barber-profiles/${barber.profileId}`)
      .expect(200);
    expect(pub.body.photoUrl).toBe(second.body.photoUrl);
    await barber.client.delete(`${PROFILE}/photo`, barber.token).expect(200);
    const after = await new AuthClient(app)
      .get(`${API}/barber-profiles/${barber.profileId}`)
      .expect(200);
    expect(after.body.photoUrl).toBeNull();
    // Sin perfil, 404.
    const nobody = await kit.verified();
    await nobody.client.delete(`${PROFILE}/photo`, nobody.token).expect(404);
  });

  it('portafolio propio: subir con consentimiento, ver en público y borrar', async () => {
    const barber = await barberWithProfile();
    const upload = (consent: string) =>
      barber.client.http
        .post(`${PROFILE}/portfolio`)
        .set('X-Forwarded-For', barber.client.ip)
        .set('Authorization', `Bearer ${barber.token}`)
        .field('consent', consent)
        .field('caption', 'Degradado bajo')
        .attach('file', jpeg, { filename: 'corte.jpg', contentType: 'image/jpeg' });
    await upload('false').expect(400);
    const item = await upload('true').expect(201);
    expect(item.body).toMatchObject({ caption: 'Degradado bajo', barbershopName: null });

    const page = await new AuthClient(app)
      .get(`${API}/barber-profiles/${barber.profileId}/portfolio`)
      .expect(200);
    expect(page.body.items.map((i: { id: string }) => i.id)).toEqual([item.body.id]);
    await barber.client.delete(`${PROFILE}/portfolio/${item.body.id}`, barber.token).expect(204);
    const empty = await new AuthClient(app)
      .get(`${API}/barber-profiles/${barber.profileId}/portfolio`)
      .expect(200);
    expect(empty.body.items).toEqual([]);
  });

  it('bolsa de trabajo: postular, ver al postulante, contratar y mensajes en la bandeja', async () => {
    const shop = await kit.shopReady();
    const barber = await barberWithProfile('Luis Navaja');
    const posting = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/jobs`,
        {
          title: 'Barbero a tiempo completo',
          description: 'Turno de mañana, buen ambiente y clientela fija en Miraflores.',
          employmentType: 'FULL_TIME',
          compensationText: '50 % por servicio',
        },
        shop.owner.token,
      )
      .expect(201);
    const open = await new AuthClient(app)
      .get(`${API}/jobs?employmentType=FULL_TIME&limit=50`)
      .expect(200);
    expect(open.body.items.map((j: { id: string }) => j.id)).toContain(posting.body.id);

    // Sin perfil no se postula.
    const noProfile = await kit.verified();
    await noProfile.client
      .post(`${API}/jobs/${posting.body.id}/applications`, {}, noProfile.token)
      .expect(403);

    const application = await barber.client
      .post(
        `${API}/jobs/${posting.body.id}/applications`,
        { message: 'Tengo 5 años de experiencia.' },
        barber.token,
      )
      .expect(201);
    expect(application.body).toMatchObject({
      status: 'APPLIED',
      applicant: { displayName: 'Luis Navaja' },
    });
    const seen = await barber.client
      .get(`${API}/jobs/${posting.body.id}`, barber.token)
      .expect(200);
    expect(seen.body.myApplicationStatus).toBe('APPLIED');

    const applicants = await shop.owner.client
      .get(
        `${API}/barbershops/${shop.shopId}/jobs/${posting.body.id}/applications`,
        shop.owner.token,
      )
      .expect(200);
    expect(applicants.body).toHaveLength(1);

    // La barbería recibió un mensaje automático en su bandeja.
    const shopInbox = await shop.owner.client
      .get(`${API}/barbershops/${shop.shopId}/conversations`, shop.owner.token)
      .expect(200);
    expect(shopInbox.body.items[0]).toMatchObject({
      kind: 'PROFESSIONAL',
      counterpart: { name: 'Luis Navaja', barberProfileId: barber.profileId },
      unread: 1,
    });

    await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/job-applications/${application.body.id}/decision`,
        { status: 'HIRED' },
        shop.owner.token,
      )
      .expect(200);
    await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/job-applications/${application.body.id}/decision`,
        { status: 'REJECTED' },
        shop.owner.token,
      )
      .expect(409);

    const profile = await barber.client.get(PROFILE, barber.token).expect(200);
    expect(profile.body.workplaces).toEqual([
      expect.objectContaining({ barbershopId: shop.shopId, current: true }),
    ]);
    const inbox = await barber.client.get(`${API}/me/conversations`, barber.token).expect(200);
    const thread = await barber.client
      .get(`${API}/me/conversations/${inbox.body.items[0].id}/messages`, barber.token)
      .expect(200);
    expect(thread.body.items[0]).toMatchObject({ side: 'SYSTEM', mine: false });
    expect(thread.body.items[0].body).toContain('Te contratamos');

    // Avisos: la barbería recibió la postulación; el barbero, la contratación.
    await app.get(OutboxRelay).relayBatch(500);
    const types = async (userId: string) =>
      (await prisma.notification.findMany({ where: { userId }, select: { type: true } })).map(
        (n) => n.type,
      );
    // Un solo aviso por evento: los mensajes automáticos no avisan aparte.
    expect(new Set(await types(shop.owner.userId))).toEqual(new Set(['JOB_APPLICATION_RECEIVED']));
    expect(new Set(await types(barber.userId))).toEqual(new Set(['JOB_APPLICATION_UPDATED']));

    // Ya trabaja ahí: no puede volver a postular.
    await barber.client
      .post(`${API}/jobs/${posting.body.id}/applications`, {}, barber.token)
      .expect(409);
  });

  it('trabaja en dos barberías sin cruces de horario; al irse conserva valoraciones y cortes', async () => {
    const [shopA, shopB] = [await kit.shopReady(), await kit.shopReady()];
    const barber = await barberWithProfile('Mario Doble');
    const linkA = await hire(shopA, barber);
    const linkB = await hire(shopB, barber);
    const client = await kit.verified();

    const at = new Date(lima(MONDAY, '12:00')).toISOString();
    const bookAt = (shop: KitShop, barberId: string, who: Person) =>
      who.client
        .post(
          `${API}/bookings`,
          { barbershopId: shop.shopId, serviceId: shop.serviceId, startAt: at, barberId },
          who.token,
        )
        .set('Idempotency-Key', randomUUID());
    const first = await bookAt(shopA, linkA, client).expect(201);
    // El turno ya no se ofrece en la otra barbería, y si se intenta igual, 409.
    const slots = await new AuthClient(app)
      .get(
        `${API}/barbershops/${shopB.shopId}/availability?serviceId=${shopB.serviceId}&date=${MONDAY}&barberId=${linkB}`,
      )
      .expect(200);
    expect(slots.body.slots.map((x: { startAt: string }) => x.startAt)).not.toContain(at);
    const other = await kit.verified();
    const clash = await bookAt(shopB, linkB, other).expect(409);
    expect(clash.body.code).toBe('SLOT_NOT_AVAILABLE');

    // Se atiende y se valora: cuenta para su perfil.
    const booking = await kit.attended(
      { ...shopA, barberId: linkA },
      lima(MONDAY, '14:00'),
      client,
    );
    await client.client
      .post(
        `${API}/bookings/${booking.id}/review`,
        { rating: 5, comment: 'Excelente' },
        client.token,
      )
      .expect(201);
    const before = await new AuthClient(app)
      .get(`${API}/barber-profiles/${barber.profileId}`)
      .expect(200);
    expect(before.body).toMatchObject({ ratingAverage: 5, ratingCount: 1, attendedCount: 1 });

    // Con una reserva futura activa no puede irse; cancelada, sí.
    await barber.client.post(`${PROFILE}/workplaces/${linkA}/leave`, {}, barber.token).expect(409);
    await client.client
      .post(`${API}/bookings/${first.body.id}/cancel`, {}, client.token)
      .expect(200);
    const left = await barber.client
      .post(`${PROFILE}/workplaces/${linkA}/leave`, {}, barber.token)
      .expect(200);
    expect(
      left.body.workplaces.find((w: { barberId: string }) => w.barberId === linkA),
    ).toMatchObject({
      current: false,
    });
    const after = await new AuthClient(app)
      .get(`${API}/barber-profiles/${barber.profileId}`)
      .expect(200);
    expect(after.body).toMatchObject({ ratingAverage: 5, ratingCount: 1, attendedCount: 1 });
    expect(after.body.workplaces.map((w: { barbershopId: string }) => w.barbershopId)).toEqual([
      shopB.shopId,
    ]);
    // La barbería ya no lo muestra entre sus barberos activos.
    const team = await new AuthClient(app)
      .get(`${API}/barbershops/${shopA.shopId}/barbers`)
      .expect(200);
    expect(team.body.items.map((b: { id: string }) => b.id)).not.toContain(linkA);
  });

  it('ranking: entra con 3 valoraciones, filtros por especialidad y disponibilidad', async () => {
    const shop = await kit.shopReady();
    const barber = await barberWithProfile('Rafa Ranking');
    const link = await hire(shop, barber);
    const style = await prisma.serviceStyle.findFirstOrThrow({ where: { isActive: true } });
    await barber.client
      .put(`${PROFILE}/specialties`, { styleIds: [style.id] }, barber.token)
      .expect(200);
    // Reservas con el vínculo contratado (cuentan para su perfil).
    const asHired = { ...shop, barberId: link };
    for (const hour of ['10:00', '11:00', '12:00']) {
      clock.current = lima(MONDAY, '08:00');
      const client = await kit.verified();
      const booking = await kit.attended(asHired, lima(MONDAY, hour), client);
      await client.client
        .post(`${API}/bookings/${booking.id}/review`, { rating: 5 }, client.token)
        .expect(201);
    }
    const ranking = await new AuthClient(app)
      .get(`${API}/barbers/ranking?style=${style.key}&availableForWork=true&q=Rafa%20Ranking`)
      .expect(200);
    expect(ranking.body.items[0]).toMatchObject({
      id: barber.profileId,
      rank: 1,
      ratingAverage: 5,
      ratingCount: 3,
      attendedCount: 3,
      currentBarbershops: [expect.any(String)],
    });
    expect(ranking.body.items[0].score).toBeCloseTo((5 * 4 + 5 * 3) / 8, 3);
    const profile = await new AuthClient(app)
      .get(`${API}/barber-profiles/${barber.profileId}`)
      .expect(200);
    expect(profile.body.rank).toEqual(expect.any(Number));
    const reviews = await new AuthClient(app)
      .get(`${API}/barber-profiles/${barber.profileId}/reviews`)
      .expect(200);
    expect(reviews.body.items).toHaveLength(3);
  });
});
