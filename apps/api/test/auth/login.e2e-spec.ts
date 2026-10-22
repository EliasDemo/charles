import type { NestExpressApplication } from '@nestjs/platform-express';
import { BlindIndexKind } from '../../src/common/crypto/encryption-contexts';
import { EncryptionService } from '../../src/common/crypto/encryption.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  AuthClient,
  createAuthTestApp,
  expireLocks,
  randomPassword,
  uniqueEmail,
  waitForMail,
} from '../support/auth';

describe('RF-AUT-002 Inicio de sesión (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let encryption: EncryptionService;
  const accountKey = (email: string): string =>
    encryption.blindIndex(email, BlindIndexKind.EMAIL).toString('hex');

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
    encryption = app.get(EncryptionService);
  });
  afterAll(() => app.close());

  it('RF-AUT-002 credenciales válidas: devuelve tokens e identifica el rol', async () => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    expect(tokens).toMatchObject({
      tokenType: 'Bearer',
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: { roles: ['CLIENT'], emailVerified: false },
    });
    const expiresInMs = new Date(tokens.accessTokenExpiresAt).getTime() - Date.now();
    expect(expiresInMs).toBeGreaterThan(14 * 60_000);
    expect(expiresInMs).toBeLessThanOrEqual(15 * 60_000);
    const sessionDays =
      (new Date(tokens.refreshTokenExpiresAt).getTime() - Date.now()) / (24 * 3600_000);
    expect(Math.round(sessionDays)).toBe(30);

    const me = await client
      .get('/api/v1/test-probe/private/whoami', tokens.accessToken)
      .expect(200);
    expect(me.body).toMatchObject({ id: tokens.user.id, roles: ['CLIENT'] });
  });

  it('RF-AUT-002 el correo se compara sin distinguir mayúsculas ni espacios', async () => {
    const client = new AuthClient(app);
    const { email, password } = await client.newUser();
    await client.login(`  ${email.toUpperCase()} `, password).expect(200);
  });

  it('RF-AUT-002 contraseña incorrecta y cuenta inexistente responden exactamente igual', async () => {
    const client = new AuthClient(app);
    const { email } = await client.newUser();
    const wrong = await client.login(email, randomPassword()).expect(401);
    const missing = await new AuthClient(app).login(uniqueEmail(), randomPassword()).expect(401);
    const strip = (body: Record<string, unknown>) => ({ ...body, requestId: undefined });
    expect(strip(wrong.body)).toEqual(strip(missing.body));
    expect(wrong.body).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: 'El usuario, el correo o la contraseña no son correctos.',
    });
  });

  it('RF-AUT-002 cuenta deshabilitada: mensaje específico solo con la contraseña correcta', async () => {
    const client = new AuthClient(app);
    const { email, password, tokens } = await client.newUser();
    await prisma.user.update({ where: { id: tokens.user.id }, data: { status: 'DISABLED' } });

    const wrong = await client.login(email, randomPassword()).expect(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

    const right = await client.login(email, password).expect(403);
    expect(right.body).toMatchObject({
      code: 'ACCOUNT_DISABLED',
      message: 'Tu cuenta está deshabilitada. Contacta a soporte para más información.',
    });
  });

  describe('bloqueo progresivo (CLAUDE.md §4.1)', () => {
    it('RF-AUT-002 tras 5 fallos bloquea la cuenta 1 minuto, aun con la contraseña correcta, y avisa por correo', async () => {
      const client = new AuthClient(app);
      const { email, password } = await client.newUser();
      for (let i = 0; i < 5; i++) {
        await new AuthClient(app).login(email, randomPassword()).expect(401);
      }
      const locked = await new AuthClient(app).login(email, password).expect(429);
      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      expect(locked.body.details[0].retryAfterSeconds).toBeGreaterThan(50);
      expect(locked.body.details[0].retryAfterSeconds).toBeLessThanOrEqual(60);

      const mail = await waitForMail(app, email, 'account-locked');
      expect(mail.text).toContain('1 minuto');
    });

    it('RF-AUT-002 los bloqueos siguientes duran 5 y luego 15 minutos', async () => {
      const client = new AuthClient(app);
      const { email } = await client.newUser();
      const lockAfterFiveFailures = async (): Promise<number> => {
        for (let i = 0; i < 5; i++) await new AuthClient(app).login(email, randomPassword());
        const res = await new AuthClient(app).login(email, randomPassword()).expect(429);
        return res.body.details[0].retryAfterSeconds as number;
      };

      expect(await lockAfterFiveFailures()).toBeLessThanOrEqual(60);
      await expireLocks(app, 'account', accountKey(email));
      const second = await lockAfterFiveFailures();
      expect(second).toBeGreaterThan(240);
      expect(second).toBeLessThanOrEqual(300);
      await expireLocks(app, 'account', accountKey(email));
      const third = await lockAfterFiveFailures();
      expect(third).toBeGreaterThan(840);
      expect(third).toBeLessThanOrEqual(900);
    });

    it('RF-AUT-002 un acceso correcto reinicia el conteo de la cuenta', async () => {
      const client = new AuthClient(app);
      const { email, password } = await client.newUser();
      for (let i = 0; i < 4; i++)
        await new AuthClient(app).login(email, randomPassword()).expect(401);
      await new AuthClient(app).login(email, password).expect(200);
      for (let i = 0; i < 4; i++)
        await new AuthClient(app).login(email, randomPassword()).expect(401);
      await new AuthClient(app).login(email, password).expect(200);
    });

    /** Cambia un umbral en app_settings durante una prueba y lo elimina al terminar. */
    async function withSetting(
      key: string,
      value: number,
      run: () => Promise<void>,
    ): Promise<void> {
      await prisma.appSetting.create({ data: { key, value } });
      try {
        await run();
      } finally {
        await prisma.appSetting.delete({ where: { key } });
      }
    }

    it('RF-AUT-002 umbral por IP mayor (20 por defecto): 5 fallos desde una red compartida no la bloquean', async () => {
      const sharedNetwork = new AuthClient(app);
      for (let i = 0; i < 5; i++) {
        await sharedNetwork.login(uniqueEmail(), randomPassword()).expect(401);
      }
      const colleague = await new AuthClient(app).newUser();
      await sharedNetwork.login(colleague.email, colleague.password).expect(200);
    });

    it('RF-AUT-002 bloquea por IP al alcanzar su umbral (configurable en app_settings)', async () => {
      // 8 en vez de 20: el límite de peticiones de auth (10/min por IP) impide llegar a 20 en una prueba.
      await withSetting('auth.lockout.ip_max_failures', 8, async () => {
        const attacker = new AuthClient(app);
        for (let i = 0; i < 8; i++) {
          await attacker.login(uniqueEmail(), randomPassword()).expect(401);
        }
        const victim = await new AuthClient(app).newUser();
        const fromAttackerIp = await attacker.login(victim.email, victim.password).expect(429);
        expect(fromAttackerIp.body.code).toBe('ACCOUNT_LOCKED');
        // La cuenta en sí no está bloqueada: desde otra IP entra sin problema.
        await new AuthClient(app).login(victim.email, victim.password).expect(200);
      });
    });

    it('RF-AUT-002 el umbral por cuenta es configurable en app_settings', async () => {
      await withSetting('auth.lockout.account_max_failures', 3, async () => {
        const { email, password } = await new AuthClient(app).newUser();
        for (let i = 0; i < 3; i++) {
          await new AuthClient(app).login(email, randomPassword()).expect(401);
        }
        await new AuthClient(app).login(email, password).expect(429);
      });
    });

    it('RF-AUT-002 un umbral inválido en app_settings usa el valor por defecto (5)', async () => {
      await withSetting('auth.lockout.account_max_failures', 0, async () => {
        const { email, password } = await new AuthClient(app).newUser();
        for (let i = 0; i < 4; i++) {
          await new AuthClient(app).login(email, randomPassword()).expect(401);
        }
        await new AuthClient(app).login(email, password).expect(200);
      });
    });

    it('RF-AUT-002 una cuenta inexistente se bloquea igual (no revela si existe)', async () => {
      const email = uniqueEmail();
      for (let i = 0; i < 5; i++)
        await new AuthClient(app).login(email, randomPassword()).expect(401);
      const res = await new AuthClient(app).login(email, randomPassword()).expect(429);
      expect(res.body.code).toBe('ACCOUNT_LOCKED');
    });
  });

  it('RF-AUT-002 datos incompletos: error de validación claro', async () => {
    const res = await new AuthClient(app).post('/api/v1/auth/login', { email: 'x@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { field: 'password', constraints: expect.arrayContaining(['isString']) },
    ]);
  });
});
