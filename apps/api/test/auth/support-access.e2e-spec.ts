import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp, randomPassword, uniqueEmail } from '../support/auth';

const API = '/api/v1';

/** Únicos endpoints que acepta cada alcance de sesión restringida. */
const ALLOWED_FOR_SCOPE = {
  // Cuenta deshabilitada: sus tickets y pedir la eliminación de la cuenta.
  support: new Set([
    'post /support/tickets',
    'get /me/support/tickets',
    'get /me/support/tickets/{id}',
    'post /me/support/tickets/{id}/messages',
    'get /me/account/deletion/preview',
    'get /me/account/deletion',
    'post /me/account/deletion',
  ]),
  // Cuenta pendiente de eliminación: solo consultarla o cancelarla.
  deletion: new Set(['get /me/account/deletion', 'delete /me/account/deletion']),
} as const;

interface OpenApi {
  paths: Record<string, Record<string, { security?: unknown[] }>>;
}

describe('Fase 12: POST /auth/support-access (acceso limitado de una cuenta deshabilitada, e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  async function disabledAccount() {
    const client = new AuthClient(app);
    const { email, password, tokens } = await client.newUser();
    await prisma.user.update({ where: { id: tokens.user.id }, data: { status: 'DISABLED' } });
    return { client, email, password, userId: tokens.user.id };
  }

  const supportAccess = (client: AuthClient, email: string, password: string) =>
    client.post(`${API}/auth/support-access`, { email, password });

  describe('mismo bloqueo por intentos fallidos que el inicio de sesión', () => {
    it('5 fallos en support-access bloquean la cuenta, aun con la contraseña correcta, y también el login', async () => {
      const { email, password } = await disabledAccount();
      for (let i = 0; i < 5; i++) {
        await supportAccess(new AuthClient(app), email, randomPassword()).expect(401);
      }
      const locked = await supportAccess(new AuthClient(app), email, password).expect(429);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      expect((await new AuthClient(app).login(email, password).expect(429)).body.code).toBe(
        'ACCOUNT_LOCKED',
      );
    });

    it('el contador es compartido: fallos de login y de support-access suman', async () => {
      const { email, password } = await disabledAccount();
      for (let i = 0; i < 3; i++)
        await new AuthClient(app).login(email, randomPassword()).expect(401);
      for (let i = 0; i < 2; i++) {
        await supportAccess(new AuthClient(app), email, randomPassword()).expect(401);
      }
      await supportAccess(new AuthClient(app), email, password).expect(429);
    });

    it('bloqueo por IP con el mismo umbral que el login', async () => {
      const key = 'auth.lockout.ip_max_failures';
      await prisma.appSetting.create({ data: { key, value: 8 } });
      try {
        const attacker = new AuthClient(app);
        for (let i = 0; i < 8; i++) {
          await supportAccess(attacker, uniqueEmail(), randomPassword()).expect(401);
        }
        const victim = await disabledAccount();
        const fromAttackerIp = await supportAccess(attacker, victim.email, victim.password).expect(
          429,
        );
        expect(fromAttackerIp.body.code).toBe('ACCOUNT_LOCKED');
        await supportAccess(new AuthClient(app), victim.email, victim.password).expect(200);
      } finally {
        await prisma.appSetting.delete({ where: { key } });
      }
    });

    it('cuenta inexistente y contraseña incorrecta responden igual', async () => {
      const { email } = await disabledAccount();
      const wrong = await supportAccess(new AuthClient(app), email, randomPassword()).expect(401);
      const missing = await supportAccess(
        new AuthClient(app),
        uniqueEmail(),
        randomPassword(),
      ).expect(401);
      expect(wrong.body.code).toBe(missing.body.code);
      expect(wrong.body.message).toBe(missing.body.message);
    });
  });

  it('mismo límite de peticiones que el inicio de sesión (perfil auth, 10 por minuto por IP)', async () => {
    const sameIp = new AuthClient(app);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      // Correos distintos: cuenta el límite de peticiones, no el bloqueo por cuenta.
      statuses.push((await supportAccess(sameIp, uniqueEmail(), randomPassword())).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  /** Llama a cada endpoint autenticado del OpenAPI con el token; todos deben rechazarlo. */
  async function sweep(token: string, allowed: ReadonlySet<string>, code: string): Promise<number> {
    const spec = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'openapi.json'), 'utf8'),
    ) as OpenApi;
    let checked = 0;
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!operation.security) continue;
        const relative = path.replace(/^\/api\/v1/, '');
        if (allowed.has(`${method} ${relative}`)) continue;
        const url = path.replace(/\{[^}]+\}/g, randomUUID());
        const client = new AuthClient(app);
        const res = await client.http[method as 'get'](url)
          .set('X-Forwarded-For', client.ip)
          .set('Authorization', `Bearer ${token}`)
          .send({});
        expect([`${method} ${path}`, res.status, res.body.code]).toEqual([
          `${method} ${path}`,
          403,
          code,
        ]);
        checked++;
      }
    }
    return checked;
  }

  it('scope support: el token no sirve en ningún endpoint autenticado salvo sus tickets y pedir la eliminación', async () => {
    const account = await disabledAccount();
    const access = await supportAccess(account.client, account.email, account.password).expect(200);
    expect(access.body.scope).toBe('support');
    const token = access.body.accessToken as string;
    expect(await sweep(token, ALLOWED_FOR_SCOPE.support, 'ACCOUNT_DISABLED')).toBeGreaterThan(80);
    await account.client.get(`${API}/me/support/tickets`, token).expect(200);
    await account.client.get(`${API}/me/account/deletion/preview`, token).expect(200);
  });

  it('scope deletion: el token de una cuenta pendiente de eliminación solo consulta o cancela', async () => {
    const client = new AuthClient(app);
    const { email, password, tokens } = await client.newUser();
    await client.post(`${API}/me/account/deletion`, { password }, tokens.accessToken).expect(200);
    const access = await supportAccess(client, email, password).expect(200);
    expect(access.body.scope).toBe('deletion');
    const token = access.body.accessToken as string;
    expect(
      await sweep(token, ALLOWED_FOR_SCOPE.deletion, 'ACCOUNT_PENDING_DELETION'),
    ).toBeGreaterThan(80);
    await client.get(`${API}/me/account/deletion`, token).expect(200);
  });
});
