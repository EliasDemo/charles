import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import request from 'supertest';
import type { Clock } from '../../src/common/clock/clock';
import { FakeMailer, type StoredMail } from '../../src/common/mail/fake-mailer';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import type { AuthTokensDto } from '../../src/modules/auth/dto/auth.dto';
import { createTestApp } from './create-test-app';
import { truncateAll } from './db';

export const TEST_TERMS_VERSION = 'test-terms-v1';

/** Contraseña aleatoria válida (≥ 10 caracteres, no común). Nunca contraseñas fijas en pruebas. */
export function randomPassword(): string {
  return `Pw-${randomUUID()}`;
}

export function uniqueEmail(): string {
  return `user-${randomUUID()}@example.com`;
}

/** IP aleatoria (rango de pruebas 198.18.0.0/15) para aislar límites y bloqueos por IP. */
export function randomIp(): string {
  return `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

/** App completa con base y términos preparados. */
export async function createAuthTestApp(
  options: { clock?: Clock } = {},
): Promise<NestExpressApplication> {
  const app = await createTestApp({ config: { trustProxy: ['loopback'] }, clock: options.clock });
  const prisma = app.get(PrismaService);
  await truncateAll(prisma);
  await prisma.appSetting.create({
    data: { key: 'legal.terms_version', value: TEST_TERMS_VERSION },
  });
  return app;
}

export class AuthClient {
  readonly ip = randomIp();

  constructor(private readonly app: NestExpressApplication) {}

  get http() {
    return request(this.app.getHttpServer());
  }

  post(path: string, body: object = {}, token?: string) {
    const req = this.http.post(path).set('X-Forwarded-For', this.ip).send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  get(path: string, token?: string) {
    const req = this.http.get(path).set('X-Forwarded-For', this.ip);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  patch(path: string, body: object, token?: string) {
    const req = this.http.patch(path).set('X-Forwarded-For', this.ip).send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  put(path: string, body: object, token?: string) {
    const req = this.http.put(path).set('X-Forwarded-For', this.ip).send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  delete(path: string, token?: string) {
    const req = this.http.delete(path).set('X-Forwarded-For', this.ip);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  register(overrides: Record<string, unknown> = {}) {
    return this.post('/api/v1/auth/register', {
      fullName: 'Persona de Prueba',
      email: uniqueEmail(),
      password: randomPassword(),
      acceptTerms: true,
      declaresAdult: true,
      termsVersion: TEST_TERMS_VERSION,
      ...overrides,
    });
  }

  login(email: string, password: string) {
    return this.post('/api/v1/auth/login', { email, password });
  }

  /** Registra, espera el correo de bienvenida e inicia sesión. */
  async newUser(): Promise<{ email: string; password: string; tokens: AuthTokensDto }> {
    const email = uniqueEmail();
    const password = randomPassword();
    await this.register({ email, password }).expect(202);
    await waitForMail(this.app, email, 'welcome-verification');
    const res = await this.login(email, password).expect(200);
    return { email, password, tokens: res.body as AuthTokensDto };
  }
}

/** Espera a que el worker de BullMQ entregue un correo al FakeMailer. */
export async function waitForMail(
  app: NestExpressApplication,
  to: string,
  category: string,
  timeoutMs = 10_000,
): Promise<StoredMail> {
  const mailer = app.get(FakeMailer);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await mailer.inbox()).find((m) => m.to === to && m.category === category);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No llegó el correo "${category}"`);
}

/** Correos recibidos por un destinatario (tras dar tiempo a la cola). */
export async function mailsTo(
  app: NestExpressApplication,
  to: string,
  settleMs = 500,
): Promise<StoredMail[]> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return (await app.get(FakeMailer).inbox()).filter((m) => m.to === to);
}

export function codeFrom(mail: StoredMail): string {
  const match = /\b(\d{6})\b/.exec(mail.text);
  if (!match) throw new Error('El correo no contiene un código');
  return match[1]!;
}

/** Simula el vencimiento de un bloqueo (borra la marca de bloqueo en Redis de pruebas). */
export async function expireLocks(
  app: NestExpressApplication,
  scope: 'account' | 'ip',
  id: string,
): Promise<void> {
  await app.get<Redis>(REDIS_CLIENT).del(`auth:attempts:${scope}:${id}:lock`);
}
