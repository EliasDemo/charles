import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, flushRedis } from './support/create-test-app';

const ALLOWED_ORIGIN = 'http://localhost:3001';

describe('Infraestructura HTTP (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ config: { corsOrigins: [ALLOWED_ORIGIN] } });
    await flushRedis(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('salud', () => {
    it('GET /api/v1/health responde ok con PostgreSQL y Redis reales', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    });

    it('solo existe bajo la versión /api/v1', async () => {
      await request(app.getHttpServer()).get('/api/health').expect(404);
      await request(app.getHttpServer()).get('/health').expect(404);
    });
  });

  describe('formato de error uniforme', () => {
    it('404 con code, message en español, details y requestId', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/no-existe').expect(404);
      expect(res.body).toEqual({
        code: 'NOT_FOUND',
        message: 'El recurso solicitado no existe.',
        details: [],
        requestId: res.headers['x-request-id'],
      });
    });

    it('reutiliza un X-Request-Id entrante seguro', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/no-existe')
        .set('X-Request-Id', 'abc-123')
        .expect(404);
      expect(res.headers['x-request-id']).toBe('abc-123');
      expect(res.body.requestId).toBe('abc-123');
    });

    it('reemplaza un X-Request-Id inseguro por uno generado', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-Id', 'x"><script>')
        .expect(200);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('500 no filtra el mensaje interno', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/test-probe/boom').expect(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('detalle interno');
    });
  });

  describe('validación de entrada', () => {
    it('acepta un cuerpo válido y transforma tipos', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/test-probe/echo')
        .send({ name: 'Corte', quantity: 2 })
        .expect(201);
      expect(res.body).toEqual({ name: 'Corte', quantity: 2 });
    });

    it('rechaza campos inválidos con VALIDATION_ERROR sin devolver los valores', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/test-probe/echo')
        .send({ name: 'Corte', quantity: 'valor-secreto' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details).toEqual([
        { field: 'quantity', constraints: expect.arrayContaining(['isInt']) },
      ]);
      expect(JSON.stringify(res.body)).not.toContain('valor-secreto');
    });

    it('rechaza propiedades no permitidas (forbidNonWhitelisted)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/test-probe/echo')
        .send({ name: 'Corte', quantity: 1, role: 'SUPPORT' })
        .expect(400);
      expect(res.body.details).toEqual([{ field: 'role', constraints: ['whitelistValidation'] }]);
    });

    it('JSON mal formado responde MALFORMED_JSON con requestId', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/test-probe/echo')
        .set('Content-Type', 'application/json')
        .send('{"name":')
        .expect(400);
      expect(res.body.code).toBe('MALFORMED_JSON');
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('cuerpo mayor al límite responde 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/test-probe/echo')
        .send({ name: 'x'.repeat(200_000), quantity: 1 })
        .expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('cabeceras de seguridad', () => {
    it('incluye HSTS con includeSubDomains y preload, y oculta x-powered-by', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      expect(res.headers['strict-transport-security']).toBe(
        'max-age=63072000; includeSubDomains; preload',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS con lista blanca', () => {
    it('permite un origen de la lista', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', ALLOWED_ORIGIN)
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    });

    it('no autoriza un origen fuera de la lista', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'https://evil.example')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('preflight permite Idempotency-Key para el origen permitido', async () => {
      const res = await request(app.getHttpServer())
        .options('/api/v1/health')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'idempotency-key')
        .expect(204);
      expect(res.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    });
  });
});
