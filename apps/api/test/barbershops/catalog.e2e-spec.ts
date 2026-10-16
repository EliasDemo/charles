import type { NestExpressApplication } from '@nestjs/platform-express';
import { OTHER_CATEGORY_ID } from '../../prisma/seed/categories';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, codeFrom, createAuthTestApp, mailsTo, waitForMail } from '../support/auth';
import { futureBooking, ownerWithShop } from '../support/barbershops';
import { expectConstraintViolation } from '../support/db';

const SHOPS = '/api/v1/barbershops';
const service = (o: Record<string, unknown> = {}) => ({
  name: 'Corte clásico',
  priceAmount: 2500,
  durationMinutes: 30,
  categoryKey: 'haircut',
  ...o,
});

describe('RF-SER-001…003 Servicios y RF-BRB-001…002 Barberos (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  describe('servicios', () => {
    it('RF-SER-001 registra un servicio en PEN y RF-SER-003 el cliente lo consulta con precio y duración', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const created = await client
        .post(
          `${SHOPS}/${owner.shopId}/services`,
          service({ description: 'Tijera y máquina' }),
          owner.token,
        )
        .expect(201);
      expect(created.body).toMatchObject({
        name: 'Corte clásico',
        price: { amount: 2500, currency: 'PEN' },
        durationMinutes: 30,
        isAvailable: true,
        barberIds: [],
      });

      const pub = await new AuthClient(app).get(`${SHOPS}/${owner.shopId}/services`).expect(200);
      expect(pub.body).toEqual({
        items: [
          {
            id: created.body.id,
            name: 'Corte clásico',
            description: 'Tijera y máquina',
            price: { amount: 2500, currency: 'PEN' },
            durationMinutes: 30,
            category: { key: 'haircut', name: 'Corte de cabello' },
          },
        ],
        nextCursor: null,
      });
    });

    it.each([
      ['precio 0 (no hay servicios gratuitos)', { priceAmount: 0 }, 'priceAmount', 'min'],
      ['precio negativo', { priceAmount: -100 }, 'priceAmount', 'min'],
      ['precio con decimales', { priceAmount: 25.5 }, 'priceAmount', 'isInt'],
      [
        'duración que no es múltiplo de 5',
        { durationMinutes: 32 },
        'durationMinutes',
        'isDivisibleBy',
      ],
      ['duración menor que 5', { durationMinutes: 0 }, 'durationMinutes', 'min'],
      ['duración mayor que 480', { durationMinutes: 485 }, 'durationMinutes', 'max'],
      ['moneda distinta (no se acepta)', { currency: 'USD' }, 'currency', 'whitelistValidation'],
      ['sin categoría', { categoryKey: undefined }, 'categoryKey', 'isString'],
      ['categoría con formato inválido', { categoryKey: 'Corte!' }, 'categoryKey', 'matches'],
      ['categoría inexistente', { categoryKey: 'no_existe' }, 'categoryKey', 'activeCategory'],
    ])('RF-SER-001 rechaza %s', async (_case, overrides, field, constraint) => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const res = await client
        .post(`${SHOPS}/${owner.shopId}/services`, service(overrides), owner.token)
        .expect(400);
      expect(res.body.details).toEqual(
        expect.arrayContaining([{ field, constraints: expect.arrayContaining([constraint]) }]),
      );
    });

    it('RF-SER-001 la base también rechaza un servicio con precio 0 o duración inválida', async () => {
      const owner = await ownerWithShop(new AuthClient(app));
      const base = {
        barbershopId: owner.shopId,
        name: 'X',
        currency: 'PEN',
        categoryId: OTHER_CATEGORY_ID,
      };
      await expectConstraintViolation(
        prisma.service.create({ data: { ...base, priceAmount: 0, durationMinutes: 30 } }),
        'services_price_positive_check',
      );
      await expectConstraintViolation(
        prisma.service.create({ data: { ...base, priceAmount: 100, durationMinutes: 33 } }),
        'services_duration_rule_check',
      );
    });

    it('RF-SER-001 rechaza una categoría inactiva', async () => {
      const key = `inactive_${Date.now().toString(36)}`;
      await prisma.serviceCategory.create({ data: { key, name: 'Inactiva', isActive: false } });
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const res = await client
        .post(`${SHOPS}/${owner.shopId}/services`, service({ categoryKey: key }), owner.token)
        .expect(400);
      expect(res.body.details).toEqual([{ field: 'categoryKey', constraints: ['activeCategory'] }]);
    });

    it('RF-SER-002 cambia la categoría; la auditoría guarda el valor anterior y el nuevo', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const created = await client
        .post(`${SHOPS}/${owner.shopId}/services`, service(), owner.token)
        .expect(201);
      expect(created.body.category).toEqual({ key: 'haircut', name: 'Corte de cabello' });
      const updated = await client
        .patch(
          `${SHOPS}/${owner.shopId}/services/${created.body.id}`,
          { categoryKey: 'haircut_beard' },
          owner.token,
        )
        .expect(200);
      expect(updated.body.category).toEqual({ key: 'haircut_beard', name: 'Corte y barba' });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'service.updated', entityId: created.body.id },
      });
      const categories = await prisma.serviceCategory.findMany({
        where: { key: { in: ['haircut', 'haircut_beard'] } },
      });
      const idOf = (k: string) => categories.find((c) => c.key === k)?.id;
      expect(audit.changes).toEqual({
        values: { categoryId: { from: idOf('haircut'), to: idOf('haircut_beard') } },
      });
      await client
        .patch(
          `${SHOPS}/${owner.shopId}/services/${created.body.id}`,
          { categoryKey: null },
          owner.token,
        )
        .expect(400);
    });

    it('lista pública de categorías: solo activas, en orden, sin sesión', async () => {
      const res = await new AuthClient(app).get('/api/v1/service-categories').expect(200);
      const keys = (res.body.items as { key: string }[]).map((c) => c.key);
      expect(keys.slice(0, 9)).toEqual([
        'haircut',
        'beard',
        'haircut_beard',
        'kids_haircut',
        'hair_color',
        'hair_treatment',
        'shave',
        'eyebrows',
        'other',
      ]);
      expect(keys.some((k) => k.startsWith('inactive_'))).toBe(false);
      expect(res.body.items[0]).toEqual({ key: 'haircut', name: 'Corte de cabello' });
    });

    it('RF-SER-002 actualiza precio y duración; la auditoría guarda valor anterior y nuevo', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const created = await client
        .post(`${SHOPS}/${owner.shopId}/services`, service(), owner.token)
        .expect(201);
      await client
        .patch(
          `${SHOPS}/${owner.shopId}/services/${created.body.id}`,
          { priceAmount: 3000, durationMinutes: 45 },
          owner.token,
        )
        .expect(200);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'service.updated', entityId: created.body.id },
      });
      expect(audit.changes).toEqual({
        values: {
          priceAmount: { from: 2500, to: 3000 },
          durationMinutes: { from: 30, to: 45 },
        },
      });
      await client
        .patch(
          `${SHOPS}/${owner.shopId}/services/${created.body.id}`,
          { priceAmount: 0 },
          owner.token,
        )
        .expect(400);
    });

    it('RF-SER-003 el público no ve servicios no disponibles ni eliminados; el responsable sí ve los no disponibles', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const a = await client
        .post(`${SHOPS}/${owner.shopId}/services`, service({ name: 'Visible' }), owner.token)
        .expect(201);
      await client
        .post(
          `${SHOPS}/${owner.shopId}/services`,
          service({ name: 'Pausado', isAvailable: false }),
          owner.token,
        )
        .expect(201);
      const c = await client
        .post(`${SHOPS}/${owner.shopId}/services`, service({ name: 'Borrado' }), owner.token)
        .expect(201);
      await client
        .delete(`${SHOPS}/${owner.shopId}/services/${c.body.id}`, owner.token)
        .expect(204);

      const pub = await new AuthClient(app).get(`${SHOPS}/${owner.shopId}/services`).expect(200);
      expect((pub.body.items as { id: string }[]).map((s) => s.id)).toEqual([a.body.id]);
      const manage = await client
        .get(`/api/v1/me/barbershops/${owner.shopId}/services`, owner.token)
        .expect(200);
      expect((manage.body.items as { name: string }[]).map((s) => s.name).sort()).toEqual([
        'Pausado',
        'Visible',
      ]);
    });

    it('otro responsable no puede crear ni editar servicios de una barbería ajena', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const created = await client
        .post(`${SHOPS}/${owner.shopId}/services`, service(), owner.token)
        .expect(201);
      const other = await ownerWithShop(new AuthClient(app));
      const intruder = new AuthClient(app);
      await intruder.post(`${SHOPS}/${owner.shopId}/services`, service(), other.token).expect(404);
      await intruder
        .patch(
          `${SHOPS}/${owner.shopId}/services/${created.body.id}`,
          { priceAmount: 1 },
          other.token,
        )
        .expect(404);
      await intruder
        .patch(
          `${SHOPS}/${other.shopId}/services/${created.body.id}`,
          { priceAmount: 1 },
          other.token,
        )
        .expect(404);
    });
  });

  describe('barberos', () => {
    async function shopWithService() {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const svc = await client
        .post(`${SHOPS}/${owner.shopId}/services`, service(), owner.token)
        .expect(201);
      return { client, owner, serviceId: svc.body.id as string };
    }

    it('RF-BRB-001 registra barberos asociados a la barbería; el público no ve su teléfono', async () => {
      const { client, owner, serviceId } = await shopWithService();
      const res = await client
        .post(
          `${SHOPS}/${owner.shopId}/barbers`,
          {
            displayName: 'Carlos',
            bio: '10 años de experiencia',
            phone: '+51 955 111 222',
            serviceIds: [serviceId],
          },
          owner.token,
        )
        .expect(201);
      expect(res.body).toMatchObject({
        displayName: 'Carlos',
        phone: '+51 955 111 222',
        isActive: true,
        linkedUser: null,
        serviceIds: [serviceId],
      });
      await client
        .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName: 'Luis' }, owner.token)
        .expect(201);

      const stored = await prisma.barber.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(stored.phoneEnc).not.toContain('955 111 222');

      const pub = await new AuthClient(app).get(`${SHOPS}/${owner.shopId}/barbers`).expect(200);
      expect(pub.body.items).toHaveLength(2);
      expect(JSON.stringify(pub.body)).not.toMatch(/955 111 222|phone|linkedUser/);
    });

    it('RF-BRB-001 no acepta servicios de otra barbería', async () => {
      const { client, owner } = await shopWithService();
      const other = await shopWithService();
      const res = await client
        .post(
          `${SHOPS}/${owner.shopId}/barbers`,
          { displayName: 'X Y', serviceIds: [other.serviceId] },
          owner.token,
        )
        .expect(400);
      expect(res.body.details).toEqual([
        { field: 'serviceIds', constraints: ['serviceOfBarbershop'] },
      ]);
    });

    it('RF-BRB-001 el responsable se registra a sí mismo como barbero (sin invitación); una vez por barbería', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const res = await client
        .post(`${SHOPS}/${owner.shopId}/barbers/me`, {}, owner.token)
        .expect(201);
      expect(res.body).toMatchObject({
        displayName: 'Persona de Prueba',
        linkedUser: { id: owner.userId },
      });
      expect(
        (await prisma.userRole.findMany({ where: { userId: owner.userId } })).map((r) => r.role),
      ).toContain('BARBER');

      const again = await client
        .post(`${SHOPS}/${owner.shopId}/barbers/me`, {}, owner.token)
        .expect(409);
      expect(again.body.code).toBe('BARBER_ALREADY_ACTIVE_ELSEWHERE');
      const second = await client
        .post(
          SHOPS,
          {
            name: 'Sede 2',
            address: 'Calle 2, Lima',
            latitude: -12.1,
            longitude: -77,
            phone: '+51 1 111 1111',
          },
          owner.token,
        )
        .expect(201);
      // Carrera del barbero: puede trabajar también en su otra sede.
      await client.post(`${SHOPS}/${second.body.id}/barbers/me`, {}, owner.token).expect(201);
    });

    it('RF-BRB-001 invitación: la cuenta del barbero se vincula al aceptar el código', async () => {
      const { client, owner } = await shopWithService();
      const barber = await client
        .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName: 'Pedro' }, owner.token)
        .expect(201);
      const barberClient = new AuthClient(app);
      const account = await barberClient.newUser();

      await client
        .post(
          `${SHOPS}/${owner.shopId}/barbers/${barber.body.id}/invitations`,
          { email: account.email },
          owner.token,
        )
        .expect(202);
      const code = codeFrom(await waitForMail(app, account.email, 'barber-invitation'));
      const list = await barberClient
        .get('/api/v1/me/barbershop-invitations', account.tokens.accessToken)
        .expect(200);
      expect(list.body.items[0]).toMatchObject({
        kind: 'BARBER',
        barberDisplayName: 'Pedro',
        memberRole: null,
      });
      await barberClient
        .post(
          `/api/v1/me/barbershop-invitations/${list.body.items[0].id}/accept`,
          { code },
          account.tokens.accessToken,
        )
        .expect(204);

      const manage = await client
        .get(`/api/v1/me/barbershops/${owner.shopId}/barbers`, owner.token)
        .expect(200);
      expect(manage.body.items[0].linkedUser).toEqual({
        id: account.tokens.user.id,
        fullName: 'Persona de Prueba',
      });
      const relogged = await barberClient.login(account.email, account.password).expect(200);
      expect(relogged.body.user.roles).toContain('BARBER');

      // Un barbero con cuenta vinculada no se puede volver a invitar.
      const res = await client
        .post(
          `${SHOPS}/${owner.shopId}/barbers/${barber.body.id}/invitations`,
          { email: account.email },
          owner.token,
        )
        .expect(409);
      expect(res.body.code).toBe('BARBER_ALREADY_LINKED');
    });

    it('RF-BRB-001 no se envía la invitación a quien ya es barbero activo en otra barbería', async () => {
      const busyClient = new AuthClient(app);
      const busy = await ownerWithShop(busyClient);
      await busyClient.post(`${SHOPS}/${busy.shopId}/barbers/me`, {}, busy.token).expect(201);

      const { client, owner } = await shopWithService();
      const barber = await client
        .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName: 'Ana' }, owner.token)
        .expect(201);
      await client
        .post(
          `${SHOPS}/${owner.shopId}/barbers/${barber.body.id}/invitations`,
          { email: busy.email },
          owner.token,
        )
        .expect(202);
      const mails = await mailsTo(app, busy.email, 800);
      expect(mails.filter((m) => m.category === 'barber-invitation')).toEqual([]);
    });

    it('RF-BRB-002 actualiza al barbero; la auditoría no guarda datos personales', async () => {
      const { client, owner, serviceId } = await shopWithService();
      const barber = await client
        .post(
          `${SHOPS}/${owner.shopId}/barbers`,
          { displayName: 'Carlos', phone: '+51 955 000 111' },
          owner.token,
        )
        .expect(201);
      const res = await client
        .patch(
          `${SHOPS}/${owner.shopId}/barbers/${barber.body.id}`,
          { displayName: 'Carlos R.', phone: '+51 955 999 888', bio: 'Nuevo' },
          owner.token,
        )
        .expect(200);
      expect(res.body).toMatchObject({
        displayName: 'Carlos R.',
        phone: '+51 955 999 888',
        bio: 'Nuevo',
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barber.updated', entityId: barber.body.id },
      });
      expect(audit.changes).toEqual({ personalFields: ['displayName', 'bio', 'phone'] });
      expect(JSON.stringify(audit.changes)).not.toMatch(/Carlos|955 999 888|955 000 111/);

      await client
        .put(
          `${SHOPS}/${owner.shopId}/barbers/${barber.body.id}/services`,
          { serviceIds: [serviceId] },
          owner.token,
        )
        .expect(200);
      const servicesAudit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barber.services_changed', entityId: barber.body.id },
      });
      expect(servicesAudit.changes).toEqual({
        values: { serviceIds: { from: [], to: [serviceId] } },
      });
    });

    it('RF-BRB-002 desactivar se rechaza con reservas futuras; sin ellas, deja de ser público', async () => {
      const { client, owner, serviceId } = await shopWithService();
      const busy = await client
        .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName: 'Ocupado' }, owner.token)
        .expect(201);
      const free = await client
        .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName: 'Libre' }, owner.token)
        .expect(201);
      await futureBooking(app, {
        barbershopId: owner.shopId,
        barberId: busy.body.id,
        serviceId,
        clientId: owner.userId,
      });

      const res = await client
        .patch(`${SHOPS}/${owner.shopId}/barbers/${busy.body.id}`, { isActive: false }, owner.token)
        .expect(409);
      expect(res.body.code).toBe('HAS_FUTURE_BOOKINGS');

      await client
        .patch(`${SHOPS}/${owner.shopId}/barbers/${free.body.id}`, { isActive: false }, owner.token)
        .expect(200);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barber.updated', entityId: free.body.id },
      });
      expect(audit.changes).toEqual({ values: { isActive: { from: true, to: false } } });
      const pub = await new AuthClient(app).get(`${SHOPS}/${owner.shopId}/barbers`).expect(200);
      expect((pub.body.items as { displayName: string }[]).map((b) => b.displayName)).toEqual([
        'Ocupado',
      ]);
    });

    it('un cliente u otro responsable no pueden gestionar barberos ajenos', async () => {
      const { client, owner } = await shopWithService();
      const barber = await client
        .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName: 'Carlos' }, owner.token)
        .expect(201);
      const other = await ownerWithShop(new AuthClient(app));
      const intruder = new AuthClient(app);
      await intruder
        .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName: 'Intruso' }, other.token)
        .expect(404);
      await intruder
        .patch(
          `${SHOPS}/${owner.shopId}/barbers/${barber.body.id}`,
          { isActive: false },
          other.token,
        )
        .expect(404);
      await intruder.get(`/api/v1/me/barbershops/${owner.shopId}/barbers`, other.token).expect(404);
      await intruder
        .post(
          `${SHOPS}/${owner.shopId}/barbers/${barber.body.id}/invitations`,
          { email: 'x@example.com' },
          other.token,
        )
        .expect(404);
    });
  });
});
