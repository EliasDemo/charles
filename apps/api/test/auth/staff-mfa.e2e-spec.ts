import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { STAFF_SESSION } from '../../src/modules/auth/sessions.service';
import { totpCode, totpStep } from '../../src/modules/auth/mfa/totp';
import { AuthClient, randomIp, TEST_TERMS_VERSION } from '../support/auth';
import { createTestApp } from '../support/create-test-app';
import { truncateAll } from '../support/db';

const API = '/api/v1';

interface Person {
  client: AuthClient;
  token: string;
  userId: string;
  email: string;
  password: string;
}

describe('Personal: verificación en dos pasos, sesión de personal y sesión web (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const clock = {
    current: Date.UTC(2030, 0, 7, 13, 0, 0),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    // El cliente HTTP de las pruebas no reenvía cookies Secure sin https (los navegadores sí en
    // localhost): aquí se desactiva; en producción COOKIE_SECURE es obligatorio.
    app = await createTestApp({
      clock,
      config: { trustProxy: ['loopback'], web: { cookieDomain: null, cookieSecure: false } },
    });
    prisma = app.get(PrismaService);
    await truncateAll(prisma);
    await prisma.appSetting.create({
      data: { key: 'legal.terms_version', value: TEST_TERMS_VERSION },
    });
  });
  afterAll(() => app.close());

  async function person(role?: 'SUPPORT' | 'ADMIN'): Promise<Person> {
    const client = new AuthClient(app);
    const { email, password, tokens } = await client.newUser();
    if (role) await prisma.userRole.create({ data: { userId: tokens.user.id, role } });
    return { client, token: tokens.accessToken, userId: tokens.user.id, email, password };
  }

  const code = (secret: string, offsetSteps = 0) =>
    totpCode(secret, totpStep(clock.current) + offsetSteps);

  async function enroll(
    p: Person,
  ): Promise<{ secret: string; recoveryCodes: string[]; token: string }> {
    const setup = await p.client.post(`${API}/auth/mfa/setup`, {}, p.token).expect(200);
    expect(setup.body.otpauthUri).toContain('otpauth://totp/Charles%3A');
    const enabled = await p.client
      .post(`${API}/auth/mfa/enable`, { code: code(setup.body.secret as string) }, p.token)
      .expect(200);
    return {
      secret: setup.body.secret as string,
      recoveryCodes: enabled.body.recoveryCodes as string[],
      token: enabled.body.tokens.accessToken as string,
    };
  }

  it('el personal sin segundo factor no entra a /admin; con él, sí (12 h y 30 min de inactividad)', async () => {
    const agent = await person('SUPPORT');
    const denied = await agent.client.get(`${API}/admin/dashboard`, agent.token).expect(403);
    expect(denied.body.code).toBe('MFA_REQUIRED');

    const status = await agent.client.get(`${API}/auth/mfa`, agent.token).expect(200);
    expect(status.body).toEqual({
      enabled: false,
      required: true,
      sessionVerified: false,
      recoveryCodesRemaining: 0,
    });

    const { secret, recoveryCodes, token } = await enroll(agent);
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const me = await agent.client.get(`${API}/admin/me`, token).expect(200);
    expect(me.body).toMatchObject({
      id: agent.userId,
      role: 'SUPPORT',
      roles: ['CLIENT', 'SUPPORT'],
    });
    expect(me.body.sections).toContain('tickets');
    expect(me.body.sections).not.toContain('settings');
    const dashboard = await agent.client.get(`${API}/admin/dashboard`, token).expect(200);
    expect(dashboard.body).toMatchObject({
      ticketsOpen: expect.any(Number),
      bookingsToday: expect.any(Number),
    });

    // Sesión de personal: 30 min de inactividad, 12 h como máximo.
    const session = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: agent.userId, amr: 'mfa' },
      orderBy: { createdAt: 'desc' },
    });
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeLessThanOrEqual(
      STAFF_SESSION.idleMs + 5_000,
    );
    expect(session.absoluteExpiresAt!.getTime() - session.createdAt.getTime()).toBeLessThanOrEqual(
      STAFF_SESSION.absoluteMs + 5_000,
    );
    // El secreto se guarda cifrado; los códigos de recuperación, solo como hash.
    const stored = await prisma.userMfa.findUniqueOrThrow({ where: { userId: agent.userId } });
    expect(stored.secretEnc).not.toContain(secret);

    // El mismo código no vale dos veces; uno incorrecto, tampoco.
    await agent.client
      .post(`${API}/auth/mfa/verify`, { code: code(secret) }, agent.token)
      .expect(400);
    const again = await agent.client
      .post(`${API}/auth/mfa/verify`, { code: code(secret, 1) }, agent.token)
      .expect(200);
    expect(again.body.accessToken).toBeDefined();

    // Código de recuperación: un solo uso.
    await agent.client
      .post(
        `${API}/auth/mfa/verify`,
        { recoveryCode: recoveryCodes[0]!.toLowerCase() },
        agent.token,
      )
      .expect(200);
    await agent.client
      .post(`${API}/auth/mfa/verify`, { recoveryCode: recoveryCodes[0] }, agent.token)
      .expect(400);
    expect((await agent.client.get(`${API}/auth/mfa`, token).expect(200)).body).toMatchObject({
      enabled: true,
      sessionVerified: true,
      recoveryCodesRemaining: 9,
    });

    // Ya activo: no se puede generar otro QR.
    await agent.client.post(`${API}/auth/mfa/setup`, {}, agent.token).expect(409);

    // Códigos nuevos (exige un código TOTP de un paso aún no usado).
    clock.current += 90_000;
    const regenerated = await agent.client
      .post(`${API}/auth/mfa/recovery-codes`, { code: code(secret) }, token)
      .expect(200);
    expect(regenerated.body.recoveryCodes).toHaveLength(10);
  });

  it('5 códigos incorrectos bloquean 15 min; un cliente no puede activarlo', async () => {
    const agent = await person('SUPPORT');
    const { secret } = await enroll(agent);
    for (let i = 0; i < 5; i++) {
      await agent.client
        .post(`${API}/auth/mfa/verify`, { code: '000000' }, agent.token)
        .expect(400);
    }
    const locked = await agent.client
      .post(`${API}/auth/mfa/verify`, { code: code(secret, 1) }, agent.token)
      .expect(429);
    expect(locked.body.code).toBe('MFA_LOCKED');

    const client = await person();
    await client.client.post(`${API}/auth/mfa/setup`, {}, client.token).expect(403);
    await client.client
      .post(`${API}/auth/mfa/verify`, { code: '123456' }, client.token)
      .expect(403);
  });

  it('ADMIN reinicia el segundo factor de otro (no el propio); se cierran sus sesiones', async () => {
    const admin = await person('ADMIN');
    const adminToken = (await enroll(admin)).token;
    const agent = await person('SUPPORT');
    const agentToken = (await enroll(agent)).token;

    await admin.client
      .post(
        `${API}/admin/users/${admin.userId}/mfa/reset`,
        { reason: 'Perdí el teléfono' },
        adminToken,
      )
      .expect(403);
    await admin.client
      .post(
        `${API}/admin/users/${agent.userId}/mfa/reset`,
        { reason: 'Perdió el teléfono' },
        adminToken,
      )
      .expect(200);
    expect(await prisma.userMfa.count({ where: { userId: agent.userId } })).toBe(0);
    await agent.client.get(`${API}/admin/dashboard`, agentToken).expect(401);
    await admin.client
      .post(`${API}/admin/users/${agent.userId}/mfa/reset`, { reason: 'Otra vez' }, adminToken)
      .expect(409);
    // Soporte no puede reiniciar.
    const support = await person('SUPPORT');
    const supportToken = (await enroll(support)).token;
    await support.client
      .post(
        `${API}/admin/users/${admin.userId}/mfa/reset`,
        { reason: 'No permitido' },
        supportToken,
      )
      .expect(403);
    expect(
      (await admin.client.get(`${API}/admin/me`, adminToken).expect(200)).body.sections,
    ).toContain('settings');
  });

  it('web: cookies HttpOnly, CSRF por doble envío, renovación, segundo factor y cierre', async () => {
    const agent = await person('SUPPORT');
    const { secret } = await enroll(agent);
    const web = request.agent(app.getHttpServer());
    const ip = randomIp();

    const login = await web
      .post(`${API}/auth/web/login`)
      .set('X-Forwarded-For', ip)
      .send({ email: agent.email, password: agent.password });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({
      mfa: false,
      user: { id: agent.userId },
      csrfToken: expect.any(String),
    });
    expect(login.body.accessToken).toBeUndefined();
    const cookies = (login.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/charles_at=[^;]+;.*Path=\/api;.*HttpOnly/);
    expect(cookies).toMatch(/charles_rt=[^;]+;.*Path=\/api\/v1\/auth\/web;.*HttpOnly/);
    expect(cookies).toMatch(/charles_csrf=[^;]+;.*Path=\//);
    expect(cookies).toContain('SameSite=Lax');
    let csrf = login.body.csrfToken as string;

    // GET con la cookie funciona; /admin aún exige el segundo factor.
    await web.get(`${API}/users/me`).set('X-Forwarded-For', ip).expect(200);
    expect(
      (await web.get(`${API}/admin/dashboard`).set('X-Forwarded-For', ip).expect(403)).body.code,
    ).toBe('MFA_REQUIRED');

    // Sin CSRF, una petición que cambia datos se rechaza.
    const noCsrf = await web
      .post(`${API}/auth/web/mfa/verify`)
      .set('X-Forwarded-For', ip)
      .send({ code: code(secret, 1) })
      .expect(403);
    expect(noCsrf.body.code).toBe('CSRF_INVALID');
    await web
      .post(`${API}/auth/web/mfa/verify`)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', 'otro')
      .send({ code: code(secret, 1) })
      .expect(403);

    const verified = await web
      .post(`${API}/auth/web/mfa/verify`)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .send({ code: code(secret, 1) })
      .expect(200);
    expect(verified.body.mfa).toBe(true);
    csrf = verified.body.csrfToken as string;
    await web.get(`${API}/admin/dashboard`).set('X-Forwarded-For', ip).expect(200);

    // Renovar: exige CSRF; conserva la sesión de personal.
    await web.post(`${API}/auth/web/refresh`).set('X-Forwarded-For', ip).expect(403);
    const refreshed = await web
      .post(`${API}/auth/web/refresh`)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .expect(200);
    expect(refreshed.body.mfa).toBe(true);
    csrf = refreshed.body.csrfToken as string;
    await web.get(`${API}/admin/me`).set('X-Forwarded-For', ip).expect(200);

    // Cerrar: revoca y borra las cookies.
    await web
      .post(`${API}/auth/web/logout`)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .expect(204);
    await web.get(`${API}/admin/me`).set('X-Forwarded-For', ip).expect(401);
    // Sin cookies (borradas al cerrar), ni siquiera pasa el CSRF.
    const after = await web
      .post(`${API}/auth/web/refresh`)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .expect(403);
    expect(after.body.code).toBe('CSRF_INVALID');
  });

  it('web: activar el segundo factor desde la web; la app móvil no cambia', async () => {
    const agent = await person('ADMIN');
    const web = request.agent(app.getHttpServer());
    const ip = randomIp();
    const login = await web
      .post(`${API}/auth/web/login`)
      .set('X-Forwarded-For', ip)
      .send({ email: agent.email, password: agent.password })
      .expect(200);
    const csrf = login.body.csrfToken as string;
    const setup = await web
      .post(`${API}/auth/mfa/setup`)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .expect(200);
    const enabled = await web
      .post(`${API}/auth/web/mfa/enable`)
      .set('X-Forwarded-For', ip)
      .set('X-CSRF-Token', csrf)
      .send({ code: totpCode(setup.body.secret as string, totpStep(clock.current)) })
      .expect(200);
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    expect(enabled.body.session.mfa).toBe(true);
    await web.get(`${API}/admin/settings`).set('X-Forwarded-For', ip).expect(200);

    // App: el login devuelve los tokens en el cuerpo, como siempre.
    const mobile = await agent.client.login(agent.email, agent.password).expect(200);
    expect(mobile.body).toMatchObject({
      tokenType: 'Bearer',
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    expect(mobile.headers['set-cookie']).toBeUndefined();
  });
});
