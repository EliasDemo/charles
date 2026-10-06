import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { NodeEnv } from '../src/common/config/env.validation';
import { PaymentsProviderCheck } from '../src/modules/payments/payments-provider.check';
import { createTestApp } from './support/create-test-app';

describe('HTTPS obligatorio en producción (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({
      config: { nodeEnv: NodeEnv.Production, isProduction: true, trustProxy: ['loopback'] },
      // Esta prueba solo verifica HTTPS. En producción la app no arranca con la pasarela simulada
      // (lo prueba payments.spec.ts), así que aquí se omite esa comprobación de arranque.
      overrides: [
        { provide: PaymentsProviderCheck, useValue: { onApplicationBootstrap: () => undefined } },
      ],
    });
  });
  afterAll(() => app.close());

  it('rechaza peticiones HTTP con 403 HTTPS_REQUIRED', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(403);
    expect(res.body).toEqual({
      code: 'HTTPS_REQUIRED',
      message: 'Se requiere una conexión segura (HTTPS).',
      details: [],
      requestId: res.headers['x-request-id'],
    });
  });

  it('acepta peticiones que el proxy de confianza marca como HTTPS', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Forwarded-Proto', 'https')
      .expect(200);
  });
});
