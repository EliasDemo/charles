import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { futureBooking, ownerWithShop, shopPayload } from '../support/barbershops';

const SHOPS = '/api/v1/barbershops';

describe('RF-BAR-001…004 Gestión de barberías (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  async function withSetting(key: string, value: boolean | number, run: () => Promise<void>) {
    await prisma.appSetting.create({ data: { key, value } });
    try {
      await run();
    } finally {
      await prisma.appSetting.delete({ where: { key } });
    }
  }

  describe('RF-BAR-001 registrar barbería', () => {
    it('RF-BAR-001 registra la barbería, queda asociada al responsable como OWNER y se publica de inmediato', async () => {
      const client = new AuthClient(app);
      const { email, password, tokens } = await client.newUser();
      const res = await client
        .post(SHOPS, shopPayload({ ruc: '20123456789' }), tokens.accessToken)
        .expect(201);
      expect(res.body).toMatchObject({
        name: 'Barbería E2E',
        status: 'OPEN',
        timezone: 'America/Lima',
        ruc: '20123456789',
        myRole: 'OWNER',
        ownerRoleGranted: true,
        rating: { average: 0, count: 0 },
      });

      // El rol global OWNER aparece al renovar la sesión.
      const relogged = await client.login(email, password).expect(200);
      expect(relogged.body.user.roles).toEqual(expect.arrayContaining(['CLIENT', 'OWNER']));
      expect(
        await prisma.barbershopMember.count({
          where: { barbershopId: res.body.id, userId: tokens.user.id, role: 'OWNER' },
        }),
      ).toBe(1);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barbershop.created', entityId: res.body.id },
      });
      expect(audit.changes).toEqual({ values: { status: { from: null, to: 'OPEN' } } });

      await new AuthClient(app).get(`${SHOPS}/${res.body.id}`).expect(200);
    });

    it('RF-BAR-001 una cuenta puede registrar varias sedes; /me/barbershops las lista paginadas', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const second = await client
        .post(SHOPS, shopPayload({ name: 'Sede 2' }), owner.token)
        .expect(201);
      expect(second.body.ownerRoleGranted).toBe(false);

      const page1 = await client.get('/api/v1/me/barbershops?limit=1', owner.token).expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await client
        .get(`/api/v1/me/barbershops?limit=1&cursor=${page1.body.nextCursor}`, owner.token)
        .expect(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();
      expect([page1.body.items[0].id, page2.body.items[0].id].sort()).toEqual(
        [owner.shopId, second.body.id].sort(),
      );
    });

    it.each([
      ['sin teléfono', { phone: undefined }, 'phone'],
      ['coordenadas fuera de Perú', { latitude: -34.6, longitude: -58.4 }, 'latitude'],
      ['RUC de 10 dígitos', { ruc: '2012345678' }, 'ruc'],
      ['RUC con letras', { ruc: '2012345678A' }, 'ruc'],
      ['zona horaria inválida', { timezone: 'Lima/Peru' }, 'timezone'],
      ['Instagram con otro dominio', { instagramUrl: 'https://example.com/x' }, 'instagramUrl'],
      ['sitio web sin https', { websiteUrl: 'http://example.com' }, 'websiteUrl'],
      ['sin nombre', { name: '' }, 'name'],
    ])(
      'RF-BAR-001 valida la información obligatoria: rechaza %s',
      async (_case, overrides, field) => {
        const client = new AuthClient(app);
        const { tokens } = await client.newUser();
        const res = await client
          .post(SHOPS, shopPayload(overrides), tokens.accessToken)
          .expect(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect((res.body.details as { field: string }[]).map((d) => d.field)).toContain(field);
      },
    );

    it('RF-BAR-001 exige iniciar sesión', async () => {
      await new AuthClient(app).post(SHOPS, shopPayload()).expect(401);
    });

    it('RF-BAR-001 con barbershops.require_review=true queda en PENDING_REVIEW y no es pública', async () => {
      await withSetting('barbershops.require_review', true, async () => {
        const client = new AuthClient(app);
        const owner = await ownerWithShop(client);
        const mine = await client
          .get(`/api/v1/me/barbershops/${owner.shopId}`, owner.token)
          .expect(200);
        expect(mine.body.status).toBe('PENDING_REVIEW');

        const visitor = new AuthClient(app);
        await visitor.get(`${SHOPS}/${owner.shopId}`).expect(404);
        await visitor.get(`${SHOPS}/${owner.shopId}/services`).expect(404);
        await visitor.get(`${SHOPS}/${owner.shopId}/barbers`).expect(404);

        // Solo soporte la aprueba (Fase 12): el responsable no puede abrirla.
        const res = await client
          .patch(`${SHOPS}/${owner.shopId}/status`, { status: 'OPEN' }, owner.token)
          .expect(409);
        expect(res.body.code).toBe('STATUS_CHANGE_NOT_ALLOWED');
      });
    });
  });

  describe('RF-BAR-002 consulta pública', () => {
    it('RF-BAR-002 sin iniciar sesión muestra solo datos públicos', async () => {
      const owner = await ownerWithShop(new AuthClient(app), {
        ruc: '10456789012',
        description: 'Cortes clásicos',
        instagramUrl: 'https://www.instagram.com/barberia',
      });
      const res = await new AuthClient(app).get(`${SHOPS}/${owner.shopId}`).expect(200);
      expect(res.body).toEqual({
        id: owner.shopId,
        name: 'Barbería E2E',
        description: 'Cortes clásicos',
        address: 'Av. Prueba 123, Miraflores, Lima',
        latitude: -12.12,
        longitude: -77.03,
        timezone: 'America/Lima',
        phone: '+51 1 234 5678',
        status: 'OPEN',
        closure: null,
        links: { website: null, instagram: 'https://www.instagram.com/barberia', facebook: null },
        rating: { average: 0, count: 0 },
      });
      expect(JSON.stringify(res.body)).not.toContain('10456789012');
    });

    it.each(['SUSPENDED', 'PENDING_REVIEW'] as const)(
      'RF-BAR-002 una barbería %s no aparece en consultas públicas',
      async (status) => {
        const owner = await ownerWithShop(new AuthClient(app));
        await prisma.barbershop.update({ where: { id: owner.shopId }, data: { status } });
        const visitor = new AuthClient(app);
        await visitor.get(`${SHOPS}/${owner.shopId}`).expect(404);
        await visitor.get(`${SHOPS}/${owner.shopId}/services`).expect(404);
        await visitor.get(`${SHOPS}/${owner.shopId}/barbers`).expect(404);
      },
    );

    it('RF-BAR-002 una barbería eliminada no aparece', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      await client.delete(`${SHOPS}/${owner.shopId}`, owner.token).expect(204);
      await new AuthClient(app).get(`${SHOPS}/${owner.shopId}`).expect(404);
      const mine = await client.get('/api/v1/me/barbershops', owner.token).expect(200);
      expect(mine.body.items).toEqual([]);
    });

    it('RF-BAR-002 las consultas públicas tienen límite de peticiones', async () => {
      const owner = await ownerWithShop(new AuthClient(app));
      const visitor = new AuthClient(app);
      for (let i = 0; i < 60; i++) await visitor.get(`${SHOPS}/${owner.shopId}`).expect(200);
      const res = await visitor.get(`${SHOPS}/${owner.shopId}`).expect(429);
      expect(res.body.code).toBe('TOO_MANY_REQUESTS');
    });
  });

  describe('RF-BAR-003 actualizar información', () => {
    it('RF-BAR-003 el responsable actualiza y se refleja en consultas; la auditoría guarda valores no personales', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      await client
        .patch(
          `${SHOPS}/${owner.shopId}`,
          {
            name: 'Nuevo Nombre',
            address: 'Calle Nueva 456, Lima',
            phone: '+51 1 999 8888',
            ruc: '20999999999',
          },
          owner.token,
        )
        .expect(200);

      const pub = await new AuthClient(app).get(`${SHOPS}/${owner.shopId}`).expect(200);
      expect(pub.body).toMatchObject({ name: 'Nuevo Nombre', address: 'Calle Nueva 456, Lima' });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barbershop.updated', entityId: owner.shopId },
      });
      expect(audit.changes).toEqual({
        values: {
          name: { from: 'Barbería E2E', to: 'Nuevo Nombre' },
          address: { from: 'Av. Prueba 123, Miraflores, Lima', to: 'Calle Nueva 456, Lima' },
        },
        personalFields: ['phone', 'ruc'],
      });
      expect(JSON.stringify(audit.changes)).not.toMatch(/999|20999999999/);
    });

    it('RF-BAR-003 solo el responsable autorizado puede modificar su barbería', async () => {
      const owner = await ownerWithShop(new AuthClient(app));
      const other = await ownerWithShop(new AuthClient(app));
      const stranger = new AuthClient(app);
      const { tokens } = await stranger.newUser();

      // Otro responsable (de otra barbería) y un cliente reciben 404: no se revela la barbería.
      const res = await new AuthClient(app)
        .patch(`${SHOPS}/${owner.shopId}`, { name: 'Hackeada' }, other.token)
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
      await stranger
        .patch(`${SHOPS}/${owner.shopId}`, { name: 'Hackeada' }, tokens.accessToken)
        .expect(404);
      await stranger.get(`/api/v1/me/barbershops/${owner.shopId}`, tokens.accessToken).expect(404);
      await new AuthClient(app).patch(`${SHOPS}/${owner.shopId}`, { name: 'X Y' }).expect(401);

      const pub = await new AuthClient(app).get(`${SHOPS}/${owner.shopId}`).expect(200);
      expect(pub.body.name).toBe('Barbería E2E');
    });

    it('RF-BAR-003 no permite vaciar campos obligatorios', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const res = await client
        .patch(`${SHOPS}/${owner.shopId}`, { name: null }, owner.token)
        .expect(400);
      expect(res.body.details).toEqual([{ field: 'name', constraints: ['isNotEmpty'] }]);
    });
  });

  describe('RF-BAR-004 estado de atención', () => {
    it('RF-BAR-004 cierre temporal con motivo y reapertura; se refleja públicamente y se audita', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const reopen = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
      await client
        .patch(
          `${SHOPS}/${owner.shopId}/status`,
          { status: 'TEMPORARILY_CLOSED', reason: 'Remodelación', expectedReopenAt: reopen },
          owner.token,
        )
        .expect(200);
      const closed = await new AuthClient(app).get(`${SHOPS}/${owner.shopId}`).expect(200);
      expect(closed.body).toMatchObject({
        status: 'TEMPORARILY_CLOSED',
        closure: { reason: 'Remodelación', expectedReopenAt: reopen },
      });

      await client
        .patch(`${SHOPS}/${owner.shopId}/status`, { status: 'OPEN' }, owner.token)
        .expect(200);
      const open = await new AuthClient(app).get(`${SHOPS}/${owner.shopId}`).expect(200);
      expect(open.body).toMatchObject({ status: 'OPEN', closure: null });

      const audits = await prisma.auditLog.findMany({
        where: { action: 'barbershop.status_changed', entityId: owner.shopId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits.map((a) => a.changes)).toEqual([
        { values: { status: { from: 'OPEN', to: 'TEMPORARILY_CLOSED' } } },
        { values: { status: { from: 'TEMPORARILY_CLOSED', to: 'OPEN' } } },
      ]);
    });

    it('RF-BAR-004 rechaza una fecha de reapertura pasada y estados que gestiona soporte', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      await client
        .patch(
          `${SHOPS}/${owner.shopId}/status`,
          {
            status: 'TEMPORARILY_CLOSED',
            expectedReopenAt: new Date(Date.now() - 3600_000).toISOString(),
          },
          owner.token,
        )
        .expect(400);
      const res = await client
        .patch(`${SHOPS}/${owner.shopId}/status`, { status: 'SUSPENDED' }, owner.token)
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');

      await prisma.barbershop.update({
        where: { id: owner.shopId },
        data: { status: 'SUSPENDED' },
      });
      const suspended = await client
        .patch(`${SHOPS}/${owner.shopId}/status`, { status: 'OPEN' }, owner.token)
        .expect(409);
      expect(suspended.body.code).toBe('STATUS_CHANGE_NOT_ALLOWED');
    });
  });

  describe('eliminar barbería', () => {
    it('se rechaza si tiene reservas futuras activas', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const service = await prisma.service.create({
        data: {
          barbershopId: owner.shopId,
          name: 'Corte',
          priceAmount: 2500,
          currency: 'PEN',
          durationMinutes: 30,
        },
      });
      const barber = await prisma.barber.create({
        data: { barbershopId: owner.shopId, displayName: 'B' },
      });
      await futureBooking(app, {
        barbershopId: owner.shopId,
        barberId: barber.id,
        serviceId: service.id,
        clientId: owner.userId,
      });
      const res = await client.delete(`${SHOPS}/${owner.shopId}`, owner.token).expect(409);
      expect(res.body.code).toBe('HAS_FUTURE_BOOKINGS');
    });
  });
});
