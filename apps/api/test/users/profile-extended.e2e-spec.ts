import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AccountDeletionService } from '../../src/modules/account/account-deletion.service';
import { IMAGE_STORAGE, type ImageStorage } from '../../src/modules/images/image-storage';
import { AuthClient, createAuthTestApp, randomPassword, waitForMail } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY } from '../support/bookings';

const ME = `${API}/users/me`;
const PHOTO = `${ME}/photo`;
const PASSWORD = `${ME}/password`;

/** Perfil ampliado: fecha de nacimiento, género, foto de perfil y cambio de contraseña. */
describe('Perfil de la cuenta: datos, foto y contraseña (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let storage: ImageStorage;
  let kit: BookingKit;
  let jpeg: Buffer;
  // "Hoy" es el lunes 2030-01-07 en Lima: con 18 años cumplidos nació el 2012-01-07 o antes.
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
    jpeg = await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 20, g: 90, b: 150 } },
    })
      .jpeg()
      .withExif({ IFD0: { Make: 'TelefonoX' } })
      .toBuffer();
  });
  afterAll(() => app.close());

  async function user() {
    const client = new AuthClient(app);
    const { email, password, tokens } = await client.newUser();
    return { client, email, password, token: tokens.accessToken, userId: tokens.user.id };
  }

  function upload(who: { client: AuthClient; token: string }, file: Buffer | null) {
    let req = who.client.http
      .put(PHOTO)
      .set('X-Forwarded-For', who.client.ip)
      .set('Authorization', `Bearer ${who.token}`);
    if (file) req = req.attach('file', file, { filename: 'yo.jpg', contentType: 'image/jpeg' });
    return req;
  }

  // ───────────── Fecha de nacimiento y género ─────────────

  it('un perfil nuevo trae los campos nuevos vacíos', async () => {
    const me = await user();
    const res = await me.client.get(ME, me.token).expect(200);
    expect(res.body).toMatchObject({ birthDate: null, gender: null, photoUrl: null });
  });

  it('guarda la fecha cifrada y el género, los devuelve y audita solo los nombres de campo', async () => {
    const me = await user();
    const res = await me.client
      .patch(ME, { birthDate: '1995-04-23', gender: 'FEMALE' }, me.token)
      .expect(200);
    expect(res.body).toMatchObject({ birthDate: '1995-04-23', gender: 'FEMALE' });
    expect((await me.client.get(ME, me.token).expect(200)).body.birthDate).toBe('1995-04-23');

    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.userId } });
    expect(row.birthDateEnc).not.toContain('1995');
    expect(row.gender).toBe('FEMALE');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.profile_updated', entityId: me.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.changes).toEqual({ fields: ['birthDate', 'gender'] });
    expect(JSON.stringify(audit.changes)).not.toContain('1995');
  });

  it('null quita la fecha y el género; omitirlos no los cambia', async () => {
    const me = await user();
    await me.client.patch(ME, { birthDate: '1990-01-01', gender: 'MALE' }, me.token).expect(200);
    const kept = await me.client.patch(ME, { fullName: 'Otro Nombre' }, me.token).expect(200);
    expect(kept.body).toMatchObject({ birthDate: '1990-01-01', gender: 'MALE' });
    const cleared = await me.client
      .patch(ME, { birthDate: null, gender: null }, me.token)
      .expect(200);
    expect(cleared.body).toMatchObject({ birthDate: null, gender: null });
  });

  it('exige 18 años cumplidos según la fecha de hoy en Lima', async () => {
    const me = await user();
    await me.client.patch(ME, { birthDate: '2012-01-07' }, me.token).expect(200);
    const young = await me.client.patch(ME, { birthDate: '2012-01-08' }, me.token).expect(400);
    expect(young.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Debes tener al menos 18 años.',
      details: [{ field: 'birthDate', constraints: ['minimumAge'] }],
    });
  });

  it.each([
    ['2001-02-30', 'validDate'],
    ['1899-12-31', 'validDate'],
    ['2001-13-01', 'validDate'],
  ])('rechaza la fecha imposible %s', async (birthDate, constraint) => {
    const me = await user();
    const res = await me.client.patch(ME, { birthDate }, me.token).expect(400);
    expect(res.body.details).toEqual([{ field: 'birthDate', constraints: [constraint] }]);
  });

  it.each([
    [{ birthDate: '23/04/1995' }, 'birthDate'],
    [{ birthDate: 19950423 }, 'birthDate'],
    [{ gender: 'UNSPECIFIED' }, 'gender'],
  ])('rechaza el formato %j', async (body, field) => {
    const me = await user();
    const res = await me.client.patch(ME, body, me.token).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  // ───────────── Foto de perfil ─────────────

  it('sube la foto: cuadrado de 512 px en WebP, sin metadatos, y aparece en el perfil', async () => {
    const me = await user();
    const res = await upload(me, jpeg).expect(200);
    expect(res.body).toEqual({
      photoUrl: expect.stringMatching(/^\/api\/v1\/media\/img\/[A-Za-z0-9_-]{22}\/square\.webp$/),
    });
    const file = await new AuthClient(app).get(res.body.photoUrl as string).expect(200);
    const meta = await sharp(file.body as Buffer).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(meta.exif).toBeUndefined();
    expect((await me.client.get(ME, me.token).expect(200)).body.photoUrl).toBe(res.body.photoUrl);
    expect(
      await prisma.auditLog.count({ where: { action: 'user.photo_updated', entityId: me.userId } }),
    ).toBe(1);
  });

  it('reemplazar borra el archivo anterior; quitar es idempotente', async () => {
    const me = await user();
    const first = (await upload(me, jpeg).expect(200)).body.photoUrl as string;
    const second = (await upload(me, jpeg).expect(200)).body.photoUrl as string;
    expect(second).not.toBe(first);
    const keyOf = (url: string) => url.replace('/api/v1/media/', '');
    expect(await storage.get(keyOf(first))).toBeNull();

    const removed = await me.client.delete(PHOTO, me.token).expect(200);
    expect(removed.body).toEqual({ photoUrl: null });
    expect(await storage.get(keyOf(second))).toBeNull();
    expect((await me.client.get(ME, me.token).expect(200)).body.photoUrl).toBeNull();
    await me.client.delete(PHOTO, me.token).expect(200);
  });

  it('rechaza lo que no es imagen, la subida sin archivo y sin sesión', async () => {
    const me = await user();
    const bad = await upload(me, Buffer.from('no soy una imagen')).expect(400);
    expect(bad.body.code).toBe('INVALID_IMAGE');
    const empty = await upload(me, null).expect(400);
    expect(empty.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'file', constraints: ['isNotEmpty'] }],
    });
    await new AuthClient(app).http.put(PHOTO).expect(401);
    await new AuthClient(app).delete(PHOTO).expect(401);
  });

  it('la barbería ve la foto del cliente en su agenda, nunca su fecha ni su género', async () => {
    const shop = await kit.shopReady();
    const client = await kit.verified();
    await client.client
      .patch(ME, { birthDate: '1990-05-05', gender: 'MALE' }, client.token)
      .expect(200);
    const photo = (await upload(client, jpeg).expect(200)).body.photoUrl as string;
    const booking = await kit.confirmed(shop, lima(MONDAY, '12:00'), client);

    const agenda = await shop.owner.client
      .get(`${API}/barbershops/${shop.shopId}/agenda?date=${MONDAY}`, shop.owner.token)
      .expect(200);
    const item = agenda.body.items.find((i: { bookingId: string }) => i.bookingId === booking.id);
    expect(item.client).toEqual({ id: client.userId, name: expect.any(String), photoUrl: photo });
    const raw = JSON.stringify(agenda.body);
    expect(raw).not.toContain('1990-05-05');
    expect(raw).not.toContain('"gender"');
  });

  it('al eliminar la cuenta se borran la foto, la fecha y el género', async () => {
    const me = await user();
    await me.client.patch(ME, { birthDate: '1990-05-05', gender: 'OTHER' }, me.token).expect(200);
    const photo = (await upload(me, jpeg).expect(200)).body.photoUrl as string;
    // Ejecuta la eliminación de esta cuenta sin esperar el periodo de gracia.
    await expect(app.get(AccountDeletionService)['execute'](me.userId)).resolves.toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.userId } });
    expect(row).toMatchObject({ photoVariants: null, gender: null, birthDateEnc: null });
    expect(await storage.get(photo.replace('/api/v1/media/', ''))).toBeNull();
  });

  // ───────────── Cambio de contraseña ─────────────

  it('cambia la contraseña: mantiene esta sesión, cierra las demás y avisa por correo', async () => {
    const me = await user();
    const other = await new AuthClient(app).login(me.email, me.password).expect(200);
    const newPassword = randomPassword();

    await me.client
      .post(PASSWORD, { currentPassword: me.password, newPassword }, me.token)
      .expect(204);

    // La sesión actual sigue; la otra ya no puede renovarse.
    await me.client.get(ME, me.token).expect(200);
    await new AuthClient(app)
      .post(`${API}/auth/refresh`, { refreshToken: other.body.refreshToken })
      .expect(401);
    await new AuthClient(app).login(me.email, me.password).expect(401);
    await new AuthClient(app).login(me.email, newPassword).expect(200);
    await waitForMail(app, me.email, 'password-changed');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.password_changed', entityId: me.userId },
    });
    expect(audit.changes).toEqual({ otherSessionsClosed: 1 });
  });

  it('contraseña actual incorrecta: 400 WRONG_PASSWORD, sin cerrar la sesión', async () => {
    const me = await user();
    const res = await me.client
      .post(
        PASSWORD,
        { currentPassword: 'no-es-la-mia-123', newPassword: randomPassword() },
        me.token,
      )
      .expect(400);
    expect(res.body).toMatchObject({
      code: 'WRONG_PASSWORD',
      message: 'La contraseña actual no es correcta.',
    });
    await me.client.get(ME, me.token).expect(200);
  });

  it('la nueva debe ser distinta, cumplir la política y requiere sesión', async () => {
    const me = await user();
    const same = await me.client
      .post(PASSWORD, { currentPassword: me.password, newPassword: me.password }, me.token)
      .expect(400);
    expect(same.body.details).toEqual([
      { field: 'newPassword', constraints: ['differentFromCurrent'] },
    ]);
    const short = await me.client
      .post(PASSWORD, { currentPassword: me.password, newPassword: 'corta' }, me.token)
      .expect(400);
    expect(short.body.code).toBe('VALIDATION_ERROR');
    await new AuthClient(app)
      .post(PASSWORD, { currentPassword: 'x', newPassword: randomPassword() })
      .expect(401);
  });
});
