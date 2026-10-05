import { generateKeyPairSync } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sign } from 'jsonwebtoken';
import { APP_CONFIG } from '../../src/common/config/app-config.token';
import type { AppConfig } from '../../src/common/config/env.validation';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';

const WHOAMI = '/api/v1/test-probe/private/whoami';

describe('Sesiones, RF-AUT-003 cierre de sesión y autorización (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  describe('token de renovación', () => {
    it('RF-AUT-002 rota el token en cada uso y la sesión sigue funcionando', async () => {
      const client = new AuthClient(app);
      const { tokens } = await client.newUser();
      const res = await client
        .post('/api/v1/auth/refresh', { refreshToken: tokens.refreshToken })
        .expect(200);
      expect(res.body.refreshToken).not.toBe(tokens.refreshToken);
      expect(res.body.user.id).toBe(tokens.user.id);
      await client.get(WHOAMI, res.body.accessToken as string).expect(200);
    });

    it('RF-AUT-003 reutilizar un token ya rotado revoca toda la sesión', async () => {
      const client = new AuthClient(app);
      const { tokens } = await client.newUser();
      const rotated = await client
        .post('/api/v1/auth/refresh', { refreshToken: tokens.refreshToken })
        .expect(200);

      const reuse = await client
        .post('/api/v1/auth/refresh', { refreshToken: tokens.refreshToken })
        .expect(401);
      expect(reuse.body.code).toBe('INVALID_REFRESH_TOKEN');

      // Toda la familia queda revocada: el token nuevo y su token de acceso dejan de servir.
      await client
        .post('/api/v1/auth/refresh', { refreshToken: rotated.body.refreshToken })
        .expect(401);
      await client.get(WHOAMI, rotated.body.accessToken as string).expect(401);
      expect(
        await prisma.auditLog.count({
          where: { action: 'auth.refresh_token_reused', actorId: tokens.user.id },
        }),
      ).toBe(1);
    });

    it('RF-AUT-003 un token desconocido o vencido no renueva la sesión', async () => {
      const client = new AuthClient(app);
      const { tokens } = await client.newUser();
      await client.post('/api/v1/auth/refresh', { refreshToken: 'x'.repeat(43) }).expect(401);
      await prisma.refreshToken.updateMany({
        where: { userId: tokens.user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await client.post('/api/v1/auth/refresh', { refreshToken: tokens.refreshToken }).expect(401);
    });

    it('RF-AUT-003 una cuenta deshabilitada no puede renovar su sesión', async () => {
      const client = new AuthClient(app);
      const { tokens } = await client.newUser();
      await prisma.user.update({ where: { id: tokens.user.id }, data: { status: 'DISABLED' } });
      await client.post('/api/v1/auth/refresh', { refreshToken: tokens.refreshToken }).expect(401);
    });

    it('el servidor guarda solo el hash del token de renovación', async () => {
      const client = new AuthClient(app);
      const { tokens } = await client.newUser();
      const rows = await prisma.refreshToken.findMany({ where: { userId: tokens.user.id } });
      expect(rows).toHaveLength(1);
      expect(Buffer.from(rows[0]!.tokenHash).toString('utf8')).not.toContain(tokens.refreshToken);
      expect(rows[0]!.tokenHash).toHaveLength(32);
    });
  });

  describe('RF-AUT-003 cierre de sesión', () => {
    it('RF-AUT-003 tras cerrar sesión, el token de acceso y el de renovación dejan de servir al instante', async () => {
      const client = new AuthClient(app);
      const { tokens } = await client.newUser();
      await client.get(WHOAMI, tokens.accessToken).expect(200);

      await client.post('/api/v1/auth/logout', {}, tokens.accessToken).expect(204);

      await client.get(WHOAMI, tokens.accessToken).expect(401);
      await client.get('/api/v1/users/me', tokens.accessToken).expect(401);
      await client.post('/api/v1/auth/refresh', { refreshToken: tokens.refreshToken }).expect(401);
    });

    it('RF-AUT-003 cerrar sesión en este dispositivo no afecta a otros', async () => {
      const client = new AuthClient(app);
      const { email, password, tokens: phone } = await client.newUser();
      const laptop = (await client.login(email, password).expect(200)).body;

      await client.post('/api/v1/auth/logout', {}, phone.accessToken).expect(204);
      await client.get(WHOAMI, phone.accessToken).expect(401);
      await client.get(WHOAMI, laptop.accessToken as string).expect(200);
    });

    it('RF-AUT-003 cerrar sesión en todos los dispositivos', async () => {
      const client = new AuthClient(app);
      const { email, password, tokens: phone } = await client.newUser();
      const laptop = (await client.login(email, password).expect(200)).body;

      await client.post('/api/v1/auth/logout', { allDevices: true }, phone.accessToken).expect(204);

      await client.get(WHOAMI, phone.accessToken).expect(401);
      await client.get(WHOAMI, laptop.accessToken as string).expect(401);
      await client.post('/api/v1/auth/refresh', { refreshToken: laptop.refreshToken }).expect(401);
      // Puede volver a iniciar sesión.
      await client.login(email, password).expect(200);
    });

    it('RF-AUT-003 cerrar sesión requiere estar autenticado', async () => {
      await new AuthClient(app).post('/api/v1/auth/logout', {}).expect(401);
    });
  });

  describe('autorización (CLAUDE.md §6.4)', () => {
    it('deniega por defecto: sin token, token mal formado o firmado con otra clave → 401', async () => {
      const client = new AuthClient(app);
      const { tokens } = await client.newUser();
      await client.get(WHOAMI).expect(401);
      await client.get(WHOAMI, 'no-es-un-jwt').expect(401);

      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const forged = sign({ sid: tokens.user.id, roles: ['SUPPORT'] }, privateKey, {
        algorithm: 'ES256',
        subject: tokens.user.id,
        issuer: 'charles-api',
        audience: 'charles-clients',
        expiresIn: 600,
      });
      await client.get(WHOAMI, forged).expect(401);

      const unsigned = sign({ sid: tokens.user.id, roles: ['SUPPORT'] }, '', {
        algorithm: 'none',
        subject: tokens.user.id,
      });
      await client.get(WHOAMI, unsigned).expect(401);
    });

    describe('la verificación del JWT solo acepta ES256 con el emisor y la audiencia de Charles', () => {
      const claimsFor = (sessionId: string) => ({ sid: sessionId, roles: ['CLIENT'] });
      const base = {
        subject: '',
        issuer: 'charles-api',
        audience: 'charles-clients',
        expiresIn: 600,
      };

      async function sessionUser() {
        const client = new AuthClient(app);
        const { tokens } = await client.newUser();
        const whoami = await client.get(WHOAMI, tokens.accessToken).expect(200);
        return { client, userId: tokens.user.id, sessionId: whoami.body.sessionId as string };
      }

      it('rechaza alg "none"', async () => {
        const { client, userId, sessionId } = await sessionUser();
        const token = sign(claimsFor(sessionId), '', {
          ...base,
          subject: userId,
          algorithm: 'none',
        });
        await client.get(WHOAMI, token).expect(401);
      });

      it('rechaza HS256 firmado usando la clave pública como secreto (confusión de algoritmo)', async () => {
        const { client, userId, sessionId } = await sessionUser();
        const publicPem = app
          .get<AppConfig>(APP_CONFIG)
          .auth.jwtKeys.publicKey.export({ type: 'spki', format: 'pem' });
        const token = sign(claimsFor(sessionId), publicPem, {
          ...base,
          subject: userId,
          algorithm: 'HS256',
        });
        await client.get(WHOAMI, token).expect(401);
      });

      it.each([
        ['emisor (iss) incorrecto', { issuer: 'otro-emisor' }],
        ['audiencia (aud) incorrecta', { audience: 'otra-audiencia' }],
      ])('rechaza un token ES256 válido con %s', async (_case, override) => {
        const { client, userId, sessionId } = await sessionUser();
        const { privateKey } = app.get<AppConfig>(APP_CONFIG).auth.jwtKeys;
        const token = sign(claimsFor(sessionId), privateKey, {
          ...base,
          ...override,
          subject: userId,
          algorithm: 'ES256',
        });
        await client.get(WHOAMI, token).expect(401);
      });

      it('control: el mismo token con la clave, el emisor y la audiencia correctos sí se acepta', async () => {
        const { client, userId, sessionId } = await sessionUser();
        const { privateKey } = app.get<AppConfig>(APP_CONFIG).auth.jwtKeys;
        const token = sign(claimsFor(sessionId), privateKey, {
          ...base,
          subject: userId,
          algorithm: 'ES256',
        });
        await client.get(WHOAMI, token).expect(200);
      });
    });

    it('el token alterado (roles modificados) se rechaza', async () => {
      const client = new AuthClient(app);
      const { tokens } = await client.newUser();
      const [header, payload, signature] = tokens.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
        string,
        unknown
      >;
      claims.roles = ['SUPPORT'];
      const tampered = [
        header,
        Buffer.from(JSON.stringify(claims)).toString('base64url'),
        signature,
      ].join('.');
      await client.get(WHOAMI, tampered).expect(401);
    });

    it('RolesGuard: un CLIENT no accede a una ruta de SUPPORT; un SUPPORT sí', async () => {
      const client = new AuthClient(app);
      const { email, password, tokens } = await client.newUser();
      const denied = await client.get(
        '/api/v1/test-probe/private/support-only',
        tokens.accessToken,
      );
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('FORBIDDEN');

      await prisma.userRole.create({ data: { userId: tokens.user.id, role: 'SUPPORT' } });
      const relogged = (await client.login(email, password).expect(200)).body;
      await client
        .get('/api/v1/test-probe/private/support-only', relogged.accessToken as string)
        .expect(200);
    });

    it('los endpoints públicos siguen accesibles sin token', async () => {
      await new AuthClient(app).get('/api/v1/health').expect(200);
      await new AuthClient(app).get('/api/v1/auth/terms').expect(200);
    });
  });
});
