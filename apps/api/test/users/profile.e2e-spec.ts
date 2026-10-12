import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';

const ME = '/api/v1/users/me';

describe('RF-CLI-001 / RF-CLI-002 Perfil del cliente (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  it('RF-CLI-001 muestra los datos de la cuenta autenticada, sin datos internos', async () => {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    const res = await client.get(ME, tokens.accessToken).expect(200);
    expect(res.body).toEqual({
      id: tokens.user.id,
      fullName: 'Persona de Prueba',
      email,
      emailVerified: false,
      phone: null,
      roles: ['CLIENT'],
      preferences: { notificationChannels: ['PUSH', 'EMAIL', 'IN_APP'], reminders: true },
      birthDate: null,
      gender: null,
      photoUrl: null,
      createdAt: expect.any(String),
    });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/password|Hash|_enc|Enc"/);
  });

  it('RF-CLI-001 cada usuario ve solo su propia información', async () => {
    const alice = await new AuthClient(app).newUser();
    const bob = await new AuthClient(app).newUser();
    const asBob = await new AuthClient(app).get(ME, bob.tokens.accessToken).expect(200);
    expect(asBob.body.id).toBe(bob.tokens.user.id);
    expect(asBob.body.email).toBe(bob.email);
    expect(JSON.stringify(asBob.body)).not.toContain(alice.email);
    // No existe una ruta para consultar el perfil de otro usuario por ID.
    await new AuthClient(app)
      .get(`/api/v1/users/${alice.tokens.user.id}`, bob.tokens.accessToken)
      .expect(404);
  });

  it('RF-CLI-001 / RF-CLI-002 requieren autenticación', async () => {
    const client = new AuthClient(app);
    await client.get(ME).expect(401);
    await client.patch(ME, { fullName: 'X Y' }).expect(401);
  });

  it('RF-CLI-002 actualiza nombre, teléfono y preferencias, y lo audita sin valores', async () => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    const res = await client
      .patch(
        ME,
        {
          fullName: 'Nombre Nuevo',
          phone: '+51 911 222 333',
          preferences: { notificationChannels: ['EMAIL'] },
        },
        tokens.accessToken,
      )
      .expect(200);
    expect(res.body).toMatchObject({
      fullName: 'Nombre Nuevo',
      phone: '+51 911 222 333',
      preferences: { notificationChannels: ['EMAIL'] },
    });
    // Se refleja en consultas posteriores.
    const again = await client.get(ME, tokens.accessToken).expect(200);
    expect(again.body.phone).toBe('+51 911 222 333');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.profile_updated', entityId: tokens.user.id },
    });
    expect(audit.changes).toEqual({
      fields: ['fullName', 'phone', 'preferences.notificationChannels'],
    });
    expect(JSON.stringify(audit.changes)).not.toContain('911');
  });

  it('RF-CLI-002 permite eliminar el teléfono con null', async () => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    await client.patch(ME, { phone: '+51 900 111 222' }, tokens.accessToken).expect(200);
    const res = await client.patch(ME, { phone: null }, tokens.accessToken).expect(200);
    expect(res.body.phone).toBeNull();
  });

  it.each([
    ['teléfono inválido', { phone: 'llámame' }, 'phone'],
    ['nombre vacío', { fullName: ' ' }, 'fullName'],
    [
      'canal desconocido',
      { preferences: { notificationChannels: ['SMS'] } },
      'preferences.notificationChannels',
    ],
    [
      'canales repetidos',
      { preferences: { notificationChannels: ['EMAIL', 'EMAIL'] } },
      'preferences.notificationChannels',
    ],
  ])('RF-CLI-002 rechaza %s sin guardar nada', async (_case, body, field) => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    const res = await client.patch(ME, body, tokens.accessToken).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].field).toBe(field);
    const me = await client.get(ME, tokens.accessToken).expect(200);
    expect(me.body.fullName).toBe('Persona de Prueba');
    expect(me.body.phone).toBeNull();
  });

  it.each([
    ['el correo (no se puede cambiar en el MVP)', { email: 'otro@example.com' }],
    ['roles', { roles: ['SUPPORT'] }],
    ['el estado', { status: 'ACTIVE' }],
    ['la contraseña', { password: 'Pw-0123456789' }],
  ])('RF-CLI-002 no permite modificar %s', async (_case, body) => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    const res = await client.patch(ME, body, tokens.accessToken).expect(400);
    expect(res.body.details[0].constraints).toEqual(['whitelistValidation']);
  });
});
