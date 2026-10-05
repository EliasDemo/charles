import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import { BlindIndexKind } from '../../src/common/crypto/encryption-contexts';
import { EncryptionService } from '../../src/common/crypto/encryption.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import {
  AuthClient,
  codeFrom,
  createAuthTestApp,
  expireLocks,
  mailsTo,
  randomPassword,
  uniqueEmail,
  waitForMail,
} from '../support/auth';

const REQUEST = '/api/v1/auth/password-reset/request';
const CONFIRM = '/api/v1/auth/password-reset/confirm';
const VERIFY_REQUEST = '/api/v1/auth/email-verification/request';
const VERIFY_CONFIRM = '/api/v1/auth/email-verification/confirm';

/** Un código de 6 dígitos distinto del correcto. */
const wrongCode = (code: string): string =>
  ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');

describe('RF-AUT-004 Recuperación de acceso y verificación de correo (e2e)', () => {
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

  async function requestCode(client: AuthClient, email: string): Promise<string> {
    await client.post(REQUEST, { email }).expect(202);
    return codeFrom(await waitForMail(app, email, 'password-reset'));
  }

  it('RF-AUT-004 la respuesta es idéntica exista o no la cuenta, y solo la existente recibe correo', async () => {
    const client = new AuthClient(app);
    const { email } = await client.newUser();
    const missingEmail = uniqueEmail();

    const existing = await client.post(REQUEST, { email }).expect(202);
    const missing = await client.post(REQUEST, { email: missingEmail }).expect(202);
    expect(missing.body).toEqual(existing.body);

    await waitForMail(app, email, 'password-reset');
    expect(await mailsTo(app, missingEmail)).toEqual([]);
  });

  it('RF-AUT-004 con el código se establece una contraseña nueva, se cierran las sesiones y se avisa', async () => {
    const client = new AuthClient(app);
    const { email, password, tokens } = await client.newUser();
    const code = await requestCode(client, email);
    const newPassword = randomPassword();

    await client.post(CONFIRM, { email, code, newPassword }).expect(204);

    await client.login(email, newPassword).expect(200);
    await client.login(email, password).expect(401);
    await client.get('/api/v1/users/me', tokens.accessToken).expect(401);
    await client.post('/api/v1/auth/refresh', { refreshToken: tokens.refreshToken }).expect(401);
    await waitForMail(app, email, 'password-changed');
    expect(
      await prisma.auditLog.count({
        where: { action: 'auth.password_reset', entityId: tokens.user.id },
      }),
    ).toBe(1);
  });

  it('RF-AUT-004 el código es de un solo uso', async () => {
    const client = new AuthClient(app);
    const { email } = await client.newUser();
    const code = await requestCode(client, email);
    await client.post(CONFIRM, { email, code, newPassword: randomPassword() }).expect(204);
    const reuse = await client
      .post(CONFIRM, { email, code, newPassword: randomPassword() })
      .expect(400);
    expect(reuse.body.code).toBe('INVALID_CODE');
  });

  it('RF-AUT-004 el código se invalida tras 5 intentos fallidos, y esos fallos cuentan para el bloqueo por cuenta e IP', async () => {
    const client = new AuthClient(app);
    const { email, password } = await client.newUser();
    const code = await requestCode(client, email);

    for (let i = 0; i < 5; i++) {
      const res = await client
        .post(CONFIRM, { email, code: wrongCode(code), newPassword: randomPassword() })
        .expect(400);
      expect(res.body.code).toBe('INVALID_CODE');
    }
    // 5 fallos alcanzan el umbral de la cuenta (5): queda bloqueada.
    const locked = (await client.login(email, password).expect(429)).body;
    expect(locked.code).toBe('ACCOUNT_LOCKED');
    // También sumaron para la IP, que tiene su propio umbral (20): aún no está bloqueada.
    const redis = app.get<Redis>(REDIS_CLIENT);
    expect(await redis.get(`auth:attempts:ip:${client.ip}:failures`)).toBe('5');
    const neighbour = await new AuthClient(app).newUser();
    await client.login(neighbour.email, neighbour.password).expect(200);

    const lockedConfirm = await client
      .post(CONFIRM, { email, code, newPassword: randomPassword() })
      .expect(429);
    expect(lockedConfirm.body.code).toBe('ACCOUNT_LOCKED');

    // Aun vencido el bloqueo y desde otra IP, el código correcto ya no sirve.
    await expireLocks(app, 'account', accountKey(email));
    const otherIp = new AuthClient(app);
    const res = await otherIp
      .post(CONFIRM, { email, code, newPassword: randomPassword() })
      .expect(400);
    expect(res.body.code).toBe('INVALID_CODE');
    const stored = await prisma.passwordResetToken.findFirstOrThrow({
      where: { user: { emailHash: encryption.blindIndex(email, BlindIndexKind.EMAIL) } },
      orderBy: { createdAt: 'desc' },
    });
    expect(stored.attempts).toBe(5);
    expect(stored.usedAt).toBeNull();
    await otherIp.login(email, password).expect(200);
  });

  it('RF-AUT-004 pedir un código nuevo invalida el anterior', async () => {
    const client = new AuthClient(app);
    const { email } = await client.newUser();
    const first = await requestCode(client, email);
    await client.post(REQUEST, { email }).expect(202);
    const deadline = Date.now() + 10_000;
    let second = first;
    while (second === first && Date.now() < deadline) {
      const mails = (await mailsTo(app, email, 100)).filter((m) => m.category === 'password-reset');
      second = mails.length >= 2 ? codeFrom(mails[0]!) : first;
    }
    expect(second).not.toBe(first);
    await client.post(CONFIRM, { email, code: first, newPassword: randomPassword() }).expect(400);
    await client.post(CONFIRM, { email, code: second, newPassword: randomPassword() }).expect(204);
  });

  it('RF-AUT-004 solo se guarda el hash del código', async () => {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    const code = await requestCode(client, email);
    const row = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: tokens.user.id },
    });
    expect(row.tokenHash).toHaveLength(32);
    expect(Buffer.from(row.tokenHash).toString('utf8')).not.toContain(code);
  });

  it('RF-AUT-004 la nueva contraseña cumple la política', async () => {
    const client = new AuthClient(app);
    const { email } = await client.newUser();
    const code = await requestCode(client, email);
    const res = await client.post(CONFIRM, { email, code, newPassword: '1234567890' }).expect(400);
    expect(res.body.details).toEqual([
      { field: 'newPassword', constraints: ['notCommonPassword'] },
    ]);
  });

  it('RF-AUT-004 confirmar con una cuenta inexistente responde código inválido', async () => {
    const res = await new AuthClient(app)
      .post(CONFIRM, { email: uniqueEmail(), code: '123456', newPassword: randomPassword() })
      .expect(400);
    expect(res.body.code).toBe('INVALID_CODE');
  });

  describe('verificación de correo', () => {
    it('verifica el correo con el código de bienvenida', async () => {
      const client = new AuthClient(app);
      const email = uniqueEmail();
      const password = randomPassword();
      await client.register({ email, password }).expect(202);
      const code = codeFrom(await waitForMail(app, email, 'welcome-verification'));
      const { accessToken } = (await client.login(email, password).expect(200)).body;

      await client.post(VERIFY_CONFIRM, { code }, accessToken as string).expect(204);
      const me = await client.get('/api/v1/users/me', accessToken as string).expect(200);
      expect(me.body.emailVerified).toBe(true);
    });

    it('el código de verificación se invalida tras 5 intentos fallidos', async () => {
      const client = new AuthClient(app);
      const { email, tokens } = await client.newUser();
      await client.post(VERIFY_REQUEST, {}, tokens.accessToken).expect(202);
      const mails = async () =>
        (await mailsTo(app, email, 100)).filter((m) => m.category === 'email-verification');
      const deadline = Date.now() + 10_000;
      while ((await mails()).length === 0 && Date.now() < deadline);
      const code = codeFrom((await mails())[0]!);

      for (let i = 0; i < 5; i++) {
        await client
          .post(VERIFY_CONFIRM, { code: wrongCode(code) }, tokens.accessToken)
          .expect(400);
      }
      await client.post(VERIFY_CONFIRM, { code }, tokens.accessToken).expect(429);

      await expireLocks(app, 'account', accountKey(email));
      const otherIp = new AuthClient(app);
      const res = await otherIp.post(VERIFY_CONFIRM, { code }, tokens.accessToken).expect(400);
      expect(res.body.code).toBe('INVALID_CODE');
    });

    it('un código de recuperación no sirve para verificar el correo', async () => {
      const client = new AuthClient(app);
      const { email, tokens } = await client.newUser();
      const resetCode = await requestCode(client, email);
      await client.post(VERIFY_CONFIRM, { code: resetCode }, tokens.accessToken).expect(400);
    });

    it('verificar el correo exige estar autenticado', async () => {
      await new AuthClient(app).post(VERIFY_CONFIRM, { code: '123456' }).expect(401);
    });
  });
});
