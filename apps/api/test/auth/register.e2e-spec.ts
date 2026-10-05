import type { NestExpressApplication } from '@nestjs/platform-express';
import { BlindIndexKind, EncryptedField } from '../../src/common/crypto/encryption-contexts';
import { EncryptionService } from '../../src/common/crypto/encryption.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  AuthClient,
  createAuthTestApp,
  mailsTo,
  randomPassword,
  TEST_TERMS_VERSION,
  uniqueEmail,
  waitForMail,
} from '../support/auth';

describe('RF-AUT-001 Registro de cuenta (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let encryption: EncryptionService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
    encryption = app.get(EncryptionService);
  });
  afterAll(() => app.close());

  it('RF-AUT-001 crea una cuenta CLIENT con datos cifrados y envía el código de verificación', async () => {
    const client = new AuthClient(app);
    const email = uniqueEmail();
    const res = await client
      .register({ email, fullName: '  Ana Pérez ', phone: '+51 987 654 321' })
      .expect(202);
    expect(res.body).toEqual({
      message:
        'Recibimos tu solicitud. Revisa tu correo para continuar; luego podrás iniciar sesión.',
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { emailHash: encryption.blindIndex(email, BlindIndexKind.EMAIL) },
      include: { roles: true },
    });
    expect(user.fullName).toBe('Ana Pérez');
    expect(user.roles.map((r) => r.role)).toEqual(['CLIENT']);
    expect(user.emailEnc).not.toContain('@');
    expect(encryption.decrypt(user.emailEnc, EncryptedField.USER_EMAIL)).toBe(email);
    expect(encryption.decrypt(user.phoneEnc!, EncryptedField.USER_PHONE)).toBe('+51 987 654 321');
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.termsVersion).toBe(TEST_TERMS_VERSION);
    expect(user.adultDeclaredAt).toBeInstanceOf(Date);
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.documentNumberEnc).toBeNull();
    expect(user.birthDateEnc).toBeNull();

    const mail = await waitForMail(app, email, 'welcome-verification');
    expect(mail.text).toMatch(/\b\d{6}\b/);
    expect(
      await prisma.auditLog.count({ where: { action: 'user.registered', entityId: user.id } }),
    ).toBe(1);
  });

  it('RF-AUT-001 la cuenta registrada permite iniciar sesión sin verificar el correo', async () => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    expect(tokens.user.roles).toEqual(['CLIENT']);
    expect(tokens.user.emailVerified).toBe(false);
  });

  describe('ADR 0003: correo ya registrado', () => {
    it('RF-AUT-001 responde exactamente igual (código y cuerpo) y avisa al dueño del correo', async () => {
      const client = new AuthClient(app);
      const { email, password } = await client.newUser();

      const fresh = await client.register();
      const duplicate = await client.register({ email, password: randomPassword() });

      expect(duplicate.status).toBe(fresh.status);
      expect(duplicate.body).toEqual(fresh.body);
      expect(Object.keys(duplicate.headers).sort()).toEqual(Object.keys(fresh.headers).sort());

      await waitForMail(app, email, 'registration-attempt');
      // No se creó una segunda cuenta ni cambió la contraseña original.
      expect(
        await prisma.user.count({
          where: { emailHash: encryption.blindIndex(email, BlindIndexKind.EMAIL) },
        }),
      ).toBe(1);
      await client.login(email, password).expect(200);
    });

    it('RF-AUT-001 el tiempo de respuesta es comparable con correo nuevo y existente', async () => {
      const client = new AuthClient(app);
      const { email } = await client.newUser();
      const timeOf = async (body: Record<string, unknown>): Promise<number> => {
        const start = process.hrtime.bigint();
        await new AuthClient(app).register(body).expect(202);
        return Number(process.hrtime.bigint() - start) / 1e6;
      };
      const median = (values: number[]): number =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

      const fresh: number[] = [];
      const existing: number[] = [];
      for (let i = 0; i < 5; i++) {
        fresh.push(await timeOf({}));
        existing.push(await timeOf({ email }));
      }
      const [a, b] = [median(fresh), median(existing)];
      // Ambos caminos calculan Argon2id y encolan un correo: la diferencia debe ser pequeña.
      expect(Math.abs(a - b)).toBeLessThan(Math.max(100, 0.5 * Math.max(a, b)));
      expect(client).toBeDefined();
    });

    it('RF-AUT-001 sin aviso para un correo nuevo: solo llega el de bienvenida', async () => {
      const client = new AuthClient(app);
      const email = uniqueEmail();
      await client.register({ email }).expect(202);
      await waitForMail(app, email, 'welcome-verification');
      const mails = await mailsTo(app, email);
      expect(mails.map((m) => m.category)).toEqual(['welcome-verification']);
    });
  });

  describe('validación (RF-AUT-001: los errores se muestran claramente)', () => {
    it.each([
      ['sin aceptar términos', { acceptTerms: false }, 'acceptTerms', 'equals'],
      ['sin declarar mayoría de edad', { declaresAdult: false }, 'declaresAdult', 'equals'],
      ['contraseña corta', { password: 'corta-123' }, 'password', 'isLength'],
      ['contraseña común', { password: 'qwertyuiop' }, 'password', 'notCommonPassword'],
      [
        'contraseña común (mayúsculas)',
        { password: 'QWERTYUIOP' },
        'password',
        'notCommonPassword',
      ],
      ['correo inválido', { email: 'no-es-correo' }, 'email', 'isEmail'],
      ['teléfono inválido', { phone: 'abc' }, 'phone', 'matches'],
      ['sin nombre', { fullName: '' }, 'fullName', 'isLength'],
    ])('RF-AUT-001 rechaza %s', async (_case, body, field, constraint) => {
      const res = await new AuthClient(app).register(body).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details).toEqual(
        expect.arrayContaining([{ field, constraints: expect.arrayContaining([constraint]) }]),
      );
    });

    it.each([
      ['un rol', { role: 'OWNER' }],
      ['roles', { roles: ['SUPPORT'] }],
      ['documento (no se pide en el MVP)', { documentNumber: '12345678' }],
      ['fecha de nacimiento (no se pide en el MVP)', { birthDate: '1990-01-01' }],
    ])('RF-AUT-001 no admite enviar %s', async (_case, body) => {
      const res = await new AuthClient(app).register(body).expect(400);
      expect(res.body.details[0].constraints).toEqual(['whitelistValidation']);
    });

    it('RF-AUT-001 exige la versión vigente de los términos', async () => {
      const res = await new AuthClient(app).register({ termsVersion: 'vieja' }).expect(400);
      expect(res.body.code).toBe('TERMS_VERSION_OUTDATED');
      const terms = await new AuthClient(app).get('/api/v1/auth/terms').expect(200);
      expect(terms.body).toEqual({ version: TEST_TERMS_VERSION });
    });
  });
});
