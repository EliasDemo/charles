import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { CLOCK, type Clock } from '../../src/common/clock/clock';
import { totpCode, totpStep } from '../../src/modules/auth/mfa/totp';
import { randomIp } from './auth';

/** Secreto TOTP y último paso usado por cuenta (para verificar más de una vez en una prueba). */
const secrets = new Map<string, { secret: string; lastStep: number }>();

/**
 * Sesión de personal para las pruebas, por la API, como lo haría una persona: activa la
 * verificación en dos pasos (la primera vez) o la verifica con un código TOTP, y devuelve el token
 * de acceso de la sesión de personal (la que exige `/admin`). La cuenta ya debe tener el rol.
 */
export async function staffToken(
  app: NestExpressApplication,
  person: { token: string; userId: string },
): Promise<string> {
  // Cada llamada con su IP: el límite de autenticación es por IP (10/min).
  const http = () => {
    const agent = request(app.getHttpServer());
    return {
      post: (path: string) => agent.post(path).set('X-Forwarded-For', randomIp()),
    };
  };
  const now = app.get<Clock>(CLOCK).now();
  const known = secrets.get(person.userId);
  if (!known) {
    const setup = await http()
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${person.token}`)
      .expect(200);
    const secret = setup.body.secret as string;
    const step = totpStep(now);
    const enabled = await http()
      .post('/api/v1/auth/mfa/enable')
      .set('Authorization', `Bearer ${person.token}`)
      .send({ code: totpCode(secret, step) })
      .expect(200);
    secrets.set(person.userId, { secret, lastStep: step });
    return enabled.body.tokens.accessToken as string;
  }
  // Un mismo código no vale dos veces: se usa el paso siguiente (dentro de la tolerancia ±1).
  const step = Math.max(totpStep(now), known.lastStep + 1);
  const verified = await http()
    .post('/api/v1/auth/mfa/verify')
    .set('Authorization', `Bearer ${person.token}`)
    .send({ code: totpCode(known.secret, step) })
    .expect(200);
  known.lastStep = step;
  return verified.body.accessToken as string;
}

/** El secreto que se activó para una cuenta (para pruebas del propio 2FA). */
export function knownSecret(userId: string): string | undefined {
  return secrets.get(userId)?.secret;
}
