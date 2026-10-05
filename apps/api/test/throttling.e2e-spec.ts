import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, flushRedis } from './support/create-test-app';
import { PROBE_LIMIT } from './support/test-probe.module';

const LIMITED = '/api/v1/test-probe/limited';

async function exhaust(
  app: NestExpressApplication,
  headers: (i: number) => Record<string, string> = () => ({}),
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i <= PROBE_LIMIT; i++) {
    const res = await request(app.getHttpServer()).get(LIMITED).set(headers(i));
    statuses.push(res.status);
  }
  return statuses;
}

const allowedThenBlocked = [...Array<number>(PROBE_LIMIT).fill(200), 429];

describe('Límite de peticiones por IP real (e2e)', () => {
  describe('detrás de un proxy de confianza (TRUST_PROXY=loopback)', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      app = await createTestApp({ config: { trustProxy: ['loopback'] } });
    });
    beforeEach(() => flushRedis(app));
    afterAll(() => app.close());

    it('responde 429 TOO_MANY_REQUESTS con formato uniforme al superar el límite', async () => {
      expect(await exhaust(app, () => ({ 'X-Forwarded-For': '203.0.113.10' }))).toEqual(
        allowedThenBlocked,
      );
      const res = await request(app.getHttpServer())
        .get(LIMITED)
        .set('X-Forwarded-For', '203.0.113.10')
        .expect(429);
      expect(res.body).toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        message: 'Demasiadas solicitudes. Intenta nuevamente en unos momentos.',
      });
      expect(res.body.requestId).toBeTruthy();
    });

    it('usa la IP del cliente informada por el proxy, no la del proxy', async () => {
      const res = await request(app.getHttpServer())
        .get(LIMITED)
        .set('X-Forwarded-For', '203.0.113.20')
        .expect(200);
      expect(res.body.ip).toBe('203.0.113.20');
    });

    it('cuenta por separado a clientes distintos detrás del mismo proxy', async () => {
      await exhaust(app, () => ({ 'X-Forwarded-For': '203.0.113.30' }));
      await request(app.getHttpServer())
        .get(LIMITED)
        .set('X-Forwarded-For', '203.0.113.31')
        .expect(200);
    });

    it('no se puede evadir falsificando direcciones a la izquierda de X-Forwarded-For', async () => {
      const statuses = await exhaust(app, (i) => ({
        'X-Forwarded-For': `198.51.100.${i}, 203.0.113.40`,
      }));
      expect(statuses).toEqual(allowedThenBlocked);
    });
  });

  describe('sin proxy de confianza (TRUST_PROXY=false)', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      app = await createTestApp({ config: { trustProxy: false } });
    });
    beforeEach(() => flushRedis(app));
    afterAll(() => app.close());

    it('ignora X-Forwarded-For: cambiarla no reinicia el contador', async () => {
      const statuses = await exhaust(app, (i) => ({ 'X-Forwarded-For': `198.51.100.${i}` }));
      expect(statuses).toEqual(allowedThenBlocked);
    });
  });
});
