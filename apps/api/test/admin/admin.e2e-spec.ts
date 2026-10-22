import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { ReviewModerationService } from '../../src/modules/reviews/review-moderation.service';
import { REVIEW_RATE_LIMIT } from '../../src/modules/reviews/review-rate-limit';
import { AdminGrantError, grantRoleFromConsole } from '../../src/scripts/admin-grant-tool';
import { AuthClient, createAuthTestApp } from '../support/auth';
import {
  API,
  bookingKit,
  type BookingKit,
  HOUR,
  lima,
  MONDAY,
  type Person,
} from '../support/bookings';
import { staffToken } from '../support/mfa';

const WEDNESDAY = '2030-01-09';

type Level = 'SUPPORT' | 'ADMIN';
interface Endpoint {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: object;
  level: Level;
}

/** Todos los endpoints de /admin. Con cuerpos inválidos o IDs inexistentes: sin efectos. */
const ID = '00000000-0000-7000-8000-000000000000';
const ADMIN_ENDPOINTS: Endpoint[] = [
  { method: 'get', path: '/admin/tickets', level: 'SUPPORT' },
  { method: 'get', path: `/admin/tickets/${ID}`, level: 'SUPPORT' },
  { method: 'post', path: `/admin/tickets/${ID}/assign`, body: {}, level: 'SUPPORT' },
  { method: 'post', path: `/admin/tickets/${ID}/messages`, body: {}, level: 'SUPPORT' },
  { method: 'patch', path: `/admin/tickets/${ID}/status`, body: {}, level: 'SUPPORT' },
  { method: 'get', path: '/admin/users?email=nadie@example.com', level: 'SUPPORT' },
  { method: 'get', path: `/admin/users/${ID}`, level: 'SUPPORT' },
  { method: 'post', path: `/admin/users/${ID}/contact`, body: {}, level: 'SUPPORT' },
  { method: 'post', path: `/admin/users/${ID}/disable`, body: {}, level: 'SUPPORT' },
  { method: 'post', path: `/admin/users/${ID}/enable`, body: {}, level: 'SUPPORT' },
  { method: 'post', path: `/admin/users/${ID}/roles/support`, body: {}, level: 'ADMIN' },
  { method: 'delete', path: `/admin/users/${ID}/roles/admin`, body: {}, level: 'ADMIN' },
  { method: 'get', path: '/admin/barbershops', level: 'SUPPORT' },
  { method: 'get', path: `/admin/barbershops/${ID}`, level: 'SUPPORT' },
  { method: 'post', path: `/admin/barbershops/${ID}/approve`, body: {}, level: 'SUPPORT' },
  { method: 'post', path: `/admin/barbershops/${ID}/suspend`, body: {}, level: 'SUPPORT' },
  { method: 'post', path: `/admin/barbershops/${ID}/reactivate`, body: {}, level: 'SUPPORT' },
  { method: 'post', path: `/admin/barbershops/${ID}/reports/resolve`, body: {}, level: 'SUPPORT' },
  { method: 'get', path: `/admin/bookings/${ID}`, level: 'SUPPORT' },
  {
    method: 'post',
    path: `/admin/bookings/${ID}/attendance-correction`,
    body: {},
    level: 'SUPPORT',
  },
  { method: 'post', path: `/admin/payments/${ID}/refunds`, body: {}, level: 'ADMIN' },
  { method: 'get', path: '/admin/refunds/failed', level: 'SUPPORT' },
  { method: 'get', path: '/admin/cancellation-reviews', level: 'SUPPORT' },
  { method: 'post', path: `/admin/cancellation-reviews/${ID}/verdict`, body: {}, level: 'SUPPORT' },
  { method: 'get', path: '/admin/reviews/reported', level: 'SUPPORT' },
  { method: 'post', path: `/admin/reviews/${ID}/moderation`, body: {}, level: 'SUPPORT' },
  { method: 'get', path: '/admin/settings', level: 'ADMIN' },
  { method: 'get', path: '/admin/settings/legal.terms_version', level: 'ADMIN' },
  { method: 'put', path: '/admin/settings/legal.terms_version', body: {}, level: 'ADMIN' },
  { method: 'get', path: '/admin/service-categories', level: 'ADMIN' },
  { method: 'post', path: '/admin/service-categories', body: {}, level: 'ADMIN' },
  {
    method: 'patch',
    path: `/admin/service-categories/${ID}`,
    body: { sortOrder: -1 },
    level: 'ADMIN',
  },
];

describe('RF-OPE-001…003 Operación de la plataforma (/admin) — Fase 12 (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    kit = bookingKit(app, clock);
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
    REVIEW_RATE_LIMIT.set(1000);
  });
  afterAll(() => app.close());

  async function person(): Promise<Person> {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    return { client, token: tokens.accessToken, userId: tokens.user.id, email };
  }

  async function staff(role: Level = 'SUPPORT'): Promise<Person> {
    const p = await person();
    await prisma.userRole.create({ data: { userId: p.userId, role } });
    p.token = await staffToken(app, p);
    return p;
  }

  const call = (who: Person | null, e: Endpoint) => {
    const client = who?.client ?? new AuthClient(app);
    const req = client.http[e.method](`${API}${e.path}`).set('X-Forwarded-For', client.ip);
    if (who) req.set('Authorization', `Bearer ${who.token}`);
    return e.body ? req.send(e.body) : req;
  };
  const relayAll = async () => {
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { availableAt: new Date(0) },
    });
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
  };

  // ───────────── Matriz de autorización ─────────────

  describe('matriz de autorización de cada endpoint de /admin', () => {
    let client: Person;
    let owner: Person;
    let barber: Person;
    let support: Person;
    let admin: Person;

    beforeAll(async () => {
      client = await person();
      const shop = await kit.shopReady();
      owner = {
        client: shop.owner.client,
        token: shop.owner.token,
        userId: shop.owner.userId,
        email: '',
      };
      barber = await person();
      await prisma.userRole.create({ data: { userId: barber.userId, role: 'BARBER' } });
      support = await staff('SUPPORT');
      admin = await staff('ADMIN');
    });

    it.each(ADMIN_ENDPOINTS.map((e) => [`${e.method.toUpperCase()} ${e.path}`, e] as const))(
      '%s',
      async (_name, endpoint) => {
        expect((await call(null, endpoint)).status).toBe(401);
        for (const who of [client, owner, barber]) {
          expect((await call(who, endpoint)).status).toBe(403);
        }
        const asSupport = (await call(support, endpoint)).status;
        if (endpoint.level === 'ADMIN') expect(asSupport).toBe(403);
        else expect([401, 403]).not.toContain(asSupport);
        expect([401, 403]).not.toContain((await call(admin, endpoint)).status);
      },
    );

    it('los roles se leen de la base: quitar SUPPORT corta el acceso sin nueva sesión', async () => {
      const agent = await staff('SUPPORT');
      await agent.client.get(`${API}/admin/tickets`, agent.token).expect(200);
      await prisma.userRole.deleteMany({ where: { userId: agent.userId, role: 'SUPPORT' } });
      await agent.client.get(`${API}/admin/tickets`, agent.token).expect(403);
      // Y al revés: un rol en el token no basta si la base no lo tiene.
      const faker = await person();
      await faker.client.get(`${API}/admin/tickets`, faker.token).expect(403);
    });
  });

  // ───────────── Cuentas ─────────────

  describe('RF-OPE-001 cuentas', () => {
    it('datos mínimos; el contacto exige motivo, no se guarda en caché y se audita', async () => {
      const agent = await staff();
      const target = await person();
      const found = await agent.client
        .get(`${API}/admin/users?email=${encodeURIComponent(target.email)}`, agent.token)
        .expect(200);
      expect(Object.keys(found.body).sort()).toEqual(
        [
          'createdAt',
          'deleted',
          'emailVerified',
          'fullName',
          'id',
          'roles',
          'status',
          'username',
        ].sort(),
      );
      // También por nombre de usuario (sin distinguir mayúsculas).
      const byUsername = await agent.client
        .get(`${API}/admin/users?username=${found.body.username.toUpperCase()}`, agent.token)
        .expect(200);
      expect(byUsername.body.id).toBe(target.userId);
      await agent.client
        .get(`${API}/admin/users?username=nadie_${Date.now()}`, agent.token)
        .expect(404);
      await agent.client.get(`${API}/admin/users`, agent.token).expect(400);
      expect(JSON.stringify(found.body)).not.toContain(target.email);
      await agent.client
        .get(`${API}/admin/users?email=nadie-${randomUUID()}@example.com`, agent.token)
        .expect(404);

      await agent.client
        .post(`${API}/admin/users/${target.userId}/contact`, {}, agent.token)
        .expect(400);
      const ticket = await target.client
        .post(
          `${API}/support/tickets`,
          { category: 'ACCOUNT', subject: 'Ayuda', message: 'hola' },
          target.token,
        )
        .expect(201);
      const contact = await agent.client
        .post(
          `${API}/admin/users/${target.userId}/contact`,
          { reason: 'Verificar identidad', ticketId: ticket.body.id },
          agent.token,
        )
        .expect(200);
      expect(contact.body).toEqual({ email: target.email, phone: null });
      expect(contact.headers['cache-control']).toBe('no-store');
      // El ticket debe ser de esa cuenta.
      const otherTicket = await agent.client
        .post(
          `${API}/support/tickets`,
          { category: 'ACCOUNT', subject: 'Mío', message: 'x' },
          agent.token,
        )
        .expect(201);
      await agent.client
        .post(
          `${API}/admin/users/${target.userId}/contact`,
          { reason: 'x'.repeat(5), ticketId: otherTicket.body.id },
          agent.token,
        )
        .expect(400);
      const audit = await prisma.auditLog.findMany({
        where: { action: 'user.contact_viewed', entityId: target.userId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorId).toBe(agent.userId);
      expect(audit[0]!.changes).toEqual({
        reason: 'Verificar identidad',
        ticketId: ticket.body.id,
        actorRole: 'SUPPORT',
      });
      expect(JSON.stringify(audit[0]!.changes)).not.toContain(target.email);
      // Conflicto de interés: la propia cuenta.
      const self = await agent.client
        .post(`${API}/admin/users/${agent.userId}/contact`, { reason: 'curiosidad' }, agent.token)
        .expect(403);
      expect(self.body.code).toBe('CONFLICT_OF_INTEREST');
    });

    it('deshabilitar revoca las sesiones al instante, marca su barbería y publica el aviso', async () => {
      const agent = await staff();
      const shop = await kit.shopReady();
      const target = {
        client: shop.owner.client,
        token: shop.owner.token,
        userId: shop.owner.userId,
      };
      await target.client.get(`${API}/users/me`, target.token).expect(200);

      await agent.client
        .post(`${API}/admin/users/${target.userId}/disable`, {}, agent.token)
        .expect(400);
      const res = await agent.client
        .post(
          `${API}/admin/users/${target.userId}/disable`,
          { reason: 'Fraude reportado' },
          agent.token,
        )
        .expect(200);
      expect(res.body.status).toBe('DISABLED');
      await target.client.get(`${API}/users/me`, target.token).expect(401);
      await agent.client
        .post(`${API}/admin/users/${target.userId}/disable`, { reason: 'otra vez' }, agent.token)
        .expect(409);

      const flagged = await prisma.barbershop.findUniqueOrThrow({ where: { id: shop.shopId } });
      expect(flagged.flaggedReason).toBe('owner_disabled');
      expect(flagged.status).toBe('OPEN');
      const listed = await agent.client
        .get(`${API}/admin/barbershops?limit=100`, agent.token)
        .expect(200);
      expect(listed.body.items.map((s: { id: string }) => s.id)).toContain(shop.shopId);
      expect(
        await prisma.outboxEvent.count({
          where: { type: 'user.disabled', payload: { equals: { userId: target.userId } } },
        }),
      ).toBe(1);
      expect(
        (
          await prisma.auditLog.findFirstOrThrow({
            where: { action: 'user.disabled', entityId: target.userId },
          })
        ).changes,
      ).toMatchObject({
        reason: 'Fraude reportado',
        actorRole: 'SUPPORT',
        flaggedBarbershops: [shop.shopId],
      });

      await agent.client
        .post(`${API}/admin/users/${target.userId}/enable`, { reason: 'Aclarado' }, agent.token)
        .expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).status).toBe(
        'ACTIVE',
      );
      await agent.client
        .post(`${API}/admin/users/${target.userId}/enable`, { reason: 'Aclarado' }, agent.token)
        .expect(409);
    });

    it('soporte no deshabilita cuentas de soporte ni ADMIN; ADMIN sí; nadie a sí mismo', async () => {
      const agent = await staff();
      const otherAgent = await staff();
      const admin = await staff('ADMIN');
      await agent.client
        .post(`${API}/admin/users/${otherAgent.userId}/disable`, { reason: 'prueba' }, agent.token)
        .expect(403);
      await agent.client
        .post(`${API}/admin/users/${admin.userId}/disable`, { reason: 'prueba' }, agent.token)
        .expect(403);
      expect(
        (
          await admin.client
            .post(`${API}/admin/users/${admin.userId}/disable`, { reason: 'prueba' }, admin.token)
            .expect(403)
        ).body.code,
      ).toBe('CONFLICT_OF_INTEREST');
      await admin.client
        .post(
          `${API}/admin/users/${otherAgent.userId}/disable`,
          { reason: 'Baja del equipo' },
          admin.token,
        )
        .expect(200);
      // Deshabilitada, ya no entra a /admin aunque conserve el rol.
      await otherAgent.client.get(`${API}/admin/tickets`, otherAgent.token).expect(401);
    });

    it('roles: solo ADMIN asigna y quita; nadie se quita a sí mismo; nunca queda sin ADMIN', async () => {
      const admin = await staff('ADMIN');
      const second = await staff('ADMIN');
      const target = await person();
      await admin.client
        .post(
          `${API}/admin/users/${target.userId}/roles/support`,
          { reason: 'Nuevo agente' },
          admin.token,
        )
        .expect(200);
      // Con el rol nuevo, entra a /admin tras el segundo factor.
      target.token = await staffToken(app, target);
      await target.client.get(`${API}/admin/tickets`, target.token).expect(200);
      await admin.client
        .post(
          `${API}/admin/users/${target.userId}/roles/owner`,
          { reason: 'No aplica' },
          admin.token,
        )
        .expect(404);
      await admin.client
        .delete(`${API}/admin/users/${target.userId}/roles/support`, admin.token)
        .send({ reason: 'Fin' })
        .expect(200);
      await target.client.get(`${API}/admin/tickets`, target.token).expect(403);
      expect(
        (
          await admin.client
            .delete(`${API}/admin/users/${admin.userId}/roles/admin`, admin.token)
            .send({ reason: 'Prueba' })
            .expect(403)
        ).body.code,
      ).toBe('CONFLICT_OF_INTEREST');
      expect(
        (
          await prisma.auditLog.findMany({
            where: { entityId: target.userId, action: { startsWith: 'role.' } },
            orderBy: { createdAt: 'asc' },
          })
        ).map((a) => [a.action, (a.changes as { role: string }).role]),
      ).toEqual([
        ['role.granted', 'SUPPORT'],
        ['role.revoked', 'SUPPORT'],
      ]);

      // Solo quedan estos dos ADMIN activos (datos de esta base de pruebas): si se quitan el rol el
      // uno al otro a la vez, gana uno y el otro recibe LAST_ADMIN; nunca quedan cero.
      await prisma.userRole.deleteMany({
        where: { role: 'ADMIN', userId: { notIn: [admin.userId, second.userId] } },
      });
      const results = await Promise.all([
        admin.client
          .delete(`${API}/admin/users/${second.userId}/roles/admin`, admin.token)
          .send({ reason: 'carrera' }),
        second.client
          .delete(`${API}/admin/users/${admin.userId}/roles/admin`, second.token)
          .send({ reason: 'carrera' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.code).toBe('LAST_ADMIN');
      expect(await prisma.userRole.count({ where: { role: 'ADMIN' } })).toBe(1);
    });

    it('admin:grant crea el primer ADMIN desde la consola, auditado sin actor', async () => {
      const target = await person();
      const result = await grantRoleFromConsole(app, `  ${target.email} `, 'ADMIN');
      expect(result).toEqual({ userId: target.userId, alreadyHadRole: false });
      expect((await grantRoleFromConsole(app, target.email, 'ADMIN')).alreadyHadRole).toBe(true);
      target.token = await staffToken(app, target);
      await target.client.get(`${API}/admin/settings`, target.token).expect(200);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'role.granted', entityId: target.userId },
      });
      expect(audit.actorId).toBeNull();
      expect(audit.changes).toMatchObject({ role: 'ADMIN', via: 'console' });
      await expect(grantRoleFromConsole(app, 'nadie@example.com', 'ADMIN')).rejects.toBeInstanceOf(
        AdminGrantError,
      );
      await prisma.user.update({ where: { id: target.userId }, data: { status: 'DISABLED' } });
      await expect(grantRoleFromConsole(app, target.email, 'SUPPORT')).rejects.toThrow(
        /deshabilitada/,
      );
    });
  });

  // ───────────── Barberías ─────────────

  describe('RF-OPE-002 barberías', () => {
    it('suspender (por defecto): mantiene las próximas 48 h, cancela el resto con devolución total y las pendientes', async () => {
      const shop = await kit.shopReady([1, 3]);
      const soon = await kit.confirmed(shop, lima(MONDAY, '12:00'));
      const later = await kit.confirmed(shop, lima(WEDNESDAY, '12:00'));
      const pending = await kit.book(shop, lima(MONDAY, '14:00'));
      const agent = await staff();

      await agent.client
        .post(`${API}/admin/barbershops/${shop.shopId}/suspend`, {}, agent.token)
        .expect(400);
      const res = await agent.client
        .post(
          `${API}/admin/barbershops/${shop.shopId}/suspend`,
          { reason: 'Reportes de fraude' },
          agent.token,
        )
        .expect(200);
      expect(res.body).toEqual({
        status: 'SUSPENDED',
        mode: 'KEEP_UPCOMING',
        cancelledBookings: 2,
        keptBookings: 1,
      });

      const status = async (id: string) =>
        await prisma.booking.findUniqueOrThrow({ where: { id } });
      expect((await status(soon.id)).status).toBe('CONFIRMED');
      expect(await status(later.id)).toMatchObject({
        status: 'CANCELLED',
        cancelledByRole: 'SUPPORT',
      });
      expect((await status(pending.id)).status).toBe('CANCELLED');
      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: later.paymentId },
      });
      expect(refund).toMatchObject({ amount: 2500, reasonType: 'SUPPORT_CANCELLATION' });
      expect(await prisma.refund.count({ where: { paymentId: pending.paymentId } })).toBe(0);
      const events = await prisma.outboxEvent.findMany({
        where: {
          type: { in: ['barbershop.suspended', 'booking.cancelled'] },
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
      });
      expect(
        events.filter(
          (e) =>
            e.type === 'barbershop.suspended' &&
            (e.payload as { barbershopId: string }).barbershopId === shop.shopId,
        ),
      ).toHaveLength(1);
      expect(
        events
          .filter(
            (e) =>
              e.type === 'booking.cancelled' &&
              [later.id, pending.id].includes((e.payload as { bookingId: string }).bookingId),
          )
          .every((e) => (e.payload as { actorRole: string }).actorRole === 'SUPPORT'),
      ).toBe(true);
      // El cliente ve el motivo de soporte; la barbería no recibe revisión de cancelación (no es suya).
      expect(
        await prisma.barbershopCancellationReview.count({ where: { bookingId: later.id } }),
      ).toBe(0);
      await relayAll();
      expect(
        (await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).requestedAt,
      ).not.toBeNull();

      await agent.client
        .post(
          `${API}/admin/barbershops/${shop.shopId}/suspend`,
          { reason: 'de nuevo' },
          agent.token,
        )
        .expect(409);
      await new AuthClient(app).get(`${API}/barbershops/${shop.shopId}`).expect(404);
      const reactivated = await agent.client
        .post(
          `${API}/admin/barbershops/${shop.shopId}/reactivate`,
          { reason: 'Aclarado' },
          agent.token,
        )
        .expect(200);
      expect(reactivated.body.status).toBe('OPEN');
      await agent.client
        .post(
          `${API}/admin/barbershops/${shop.shopId}/reactivate`,
          { reason: 'Aclarado' },
          agent.token,
        )
        .expect(409);
    });

    it('suspender con CANCEL_ALL o KEEP_ALL', async () => {
      const agent = await staff();
      const a = await kit.shopReady([1]);
      const aSoon = await kit.confirmed(a, lima(MONDAY, '12:00'));
      await agent.client
        .post(
          `${API}/admin/barbershops/${a.shopId}/suspend`,
          { reason: 'Cierre', bookings: 'CANCEL_ALL' },
          agent.token,
        )
        .expect(200);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: aSoon.id } })).status).toBe(
        'CANCELLED',
      );
      const b = await kit.shopReady([3]);
      const bLater = await kit.confirmed(b, lima(WEDNESDAY, '12:00'));
      const res = await agent.client
        .post(
          `${API}/admin/barbershops/${b.shopId}/suspend`,
          { reason: 'Revisión', bookings: 'KEEP_ALL' },
          agent.token,
        )
        .expect(200);
      expect(res.body).toMatchObject({ cancelledBookings: 0, keptBookings: 1 });
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: bLater.id } })).status).toBe(
        'CONFIRMED',
      );
    });

    it('aprobar una barbería pendiente; conflicto de interés con una barbería propia', async () => {
      const shop = await kit.shopReady();
      await prisma.barbershop.update({
        where: { id: shop.shopId },
        data: { status: 'PENDING_REVIEW' },
      });
      const agent = await staff();
      const approved = await agent.client
        .post(
          `${API}/admin/barbershops/${shop.shopId}/approve`,
          { reason: 'Datos verificados' },
          agent.token,
        )
        .expect(200);
      expect(approved.body.status).toBe('OPEN');
      await agent.client
        .post(
          `${API}/admin/barbershops/${shop.shopId}/approve`,
          { reason: 'otra vez' },
          agent.token,
        )
        .expect(409);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barbershop.approved', entityId: shop.shopId },
      });
      expect(audit.changes).toMatchObject({ reason: 'Datos verificados', actorRole: 'SUPPORT' });

      await prisma.barbershopMember.create({
        data: { barbershopId: shop.shopId, userId: agent.userId, role: 'MANAGER' },
      });
      const attempts = [
        () => agent.client.get(`${API}/admin/barbershops/${shop.shopId}`, agent.token),
        () =>
          agent.client.post(
            `${API}/admin/barbershops/${shop.shopId}/suspend`,
            { reason: 'Prueba' },
            agent.token,
          ),
        () =>
          agent.client.post(
            `${API}/admin/barbershops/${shop.shopId}/reactivate`,
            { reason: 'Prueba' },
            agent.token,
          ),
        () =>
          agent.client.post(
            `${API}/admin/barbershops/${shop.shopId}/reports/resolve`,
            { resolution: 'Prueba' },
            agent.token,
          ),
      ];
      for (const attempt of attempts) {
        expect((await attempt().expect(403)).body.code).toBe('CONFLICT_OF_INTEREST');
      }
    });
  });

  // ───────────── Reservas, pagos, cancelaciones y valoraciones ─────────────

  describe('RF-OPE-003 reservas y pagos', () => {
    it('ver una reserva con datos mínimos y corregir la asistencia fuera del plazo', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.attended(shop, lima(MONDAY, '10:00'));
      const agent = await staff();
      clock.current = lima(MONDAY, '10:00') + 72 * HOUR; // pasado el plazo de 48 h del responsable
      await shop.owner.client
        .post(
          `${API}/bookings/${booking.id}/attendance-correction`,
          { status: 'NO_SHOW', reason: 'tarde' },
          shop.owner.token,
        )
        .expect(409);

      const view = await agent.client
        .get(`${API}/admin/bookings/${booking.id}`, agent.token)
        .expect(200);
      expect(view.body).toEqual(
        expect.objectContaining({
          status: 'ATTENDED',
          client: { id: booking.person.userId, fullName: expect.any(String) },
          payments: [
            expect.objectContaining({ status: 'SUCCEEDED', refundable: 2500, refunds: [] }),
          ],
        }),
      );
      expect(JSON.stringify(view.body)).not.toContain(booking.person.email);
      const corrected = await agent.client
        .post(
          `${API}/admin/bookings/${booking.id}/attendance-correction`,
          { status: 'NO_SHOW', reason: 'Reclamo con pruebas' },
          agent.token,
        )
        .expect(200);
      expect(corrected.body.status).toBe('NO_SHOW');
      expect(corrected.body.history.find((h: { to: string }) => h.to === 'NO_SHOW')).toMatchObject({
        from: 'ATTENDED',
        to: 'NO_SHOW',
        reason: 'correction: Reclamo con pruebas',
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'booking.attendance_corrected', entityId: booking.id },
      });
      expect(audit.changes).toMatchObject({ actorRole: 'SUPPORT', reason: 'Reclamo con pruebas' });

      // Conflicto de interés: soporte que es el cliente de la reserva.
      clock.current = lima(MONDAY, '08:00');
      const selfBooking = await kit.attended(shop, lima(MONDAY, '11:00'), await kit.verified());
      await prisma.userRole.create({
        data: { userId: selfBooking.person.userId, role: 'SUPPORT' },
      });
      selfBooking.person.token = await staffToken(app, selfBooking.person);
      const res = await selfBooking.person.client
        .get(`${API}/admin/bookings/${selfBooking.id}`, selfBooking.person.token)
        .expect(403);
      expect(res.body.code).toBe('CONFLICT_OF_INTEREST');
    });

    it('reembolso manual: solo ADMIN, con motivo y hasta lo cobrado; auditado', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.confirmed(shop, lima(MONDAY, '12:00'));
      const agent = await staff();
      const admin = await staff('ADMIN');
      const path = `${API}/admin/payments/${booking.paymentId}/refunds`;
      await agent.client
        .post(path, { amount: 100, reason: 'Compensación' }, agent.token)
        .expect(403);
      await admin.client.post(path, { amount: 100 }, admin.token).expect(400);
      const ok = await admin.client
        .post(path, { amount: 1000, reason: 'Compensación' }, admin.token)
        .expect(201);
      expect(ok.body).toEqual({ refundId: expect.any(String) });
      const over = await admin.client
        .post(path, { amount: 1501, reason: 'Excede' }, admin.token)
        .expect(409);
      expect(over.body).toMatchObject({
        code: 'REFUND_EXCEEDS_PAID',
        details: [{ refundable: 1500 }],
      });
      await admin.client.post(path, { amount: 1500, reason: 'Resto' }, admin.token).expect(201);
      const audit = await prisma.auditLog.findMany({
        where: { action: 'refund.manual_requested', entityId: booking.paymentId },
      });
      expect(audit.map((a) => (a.changes as { reason: string }).reason).sort()).toEqual([
        'Compensación',
        'Resto',
      ]);
      expect(audit.every((a) => a.actorId === admin.userId)).toBe(true);
      // Un pago sin cobrar no se devuelve.
      const pending = await kit.book(shop, lima(MONDAY, '15:00'));
      await admin.client
        .post(
          `${API}/admin/payments/${pending.paymentId}/refunds`,
          { amount: 1, reason: 'nada' },
          admin.token,
        )
        .expect(409);
    });

    it('cancelaciones de la barbería: soporte las califica con motivo', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.confirmed(shop, lima(MONDAY, '12:00'));
      await shop.owner.client
        .post(
          `${API}/bookings/${booking.id}/cancel`,
          { reason: 'Barbero enfermo' },
          shop.owner.token,
        )
        .expect(200);
      const agent = await staff();
      const list = await agent.client
        .get(`${API}/admin/cancellation-reviews?limit=100`, agent.token)
        .expect(200);
      const item = list.body.items.find((r: { bookingId: string }) => r.bookingId === booking.id);
      expect(item).toMatchObject({
        reason: 'Barbero enfermo',
        status: 'PENDING_REVIEW',
        barbershop: { id: shop.shopId },
      });
      const verdict = await agent.client
        .post(
          `${API}/admin/cancellation-reviews/${item.id}/verdict`,
          { verdict: 'JUSTIFIED', reason: 'Certificado médico' },
          agent.token,
        )
        .expect(200);
      expect(verdict.body).toEqual({ verdict: 'JUSTIFIED', barbershopSuspended: false });
      await agent.client
        .post(
          `${API}/admin/cancellation-reviews/${item.id}/verdict`,
          { verdict: 'UNJUSTIFIED', reason: 'cambio' },
          agent.token,
        )
        .expect(409);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barbershop.cancellation_reviewed', entityId: item.id },
      });
      expect(audit.changes).toMatchObject({ reason: 'Certificado médico' });
    });

    it('valoraciones reportadas: la cola y la decisión de soporte', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.attended(shop, lima(MONDAY, '10:00'));
      const review = await booking.person.client
        .post(
          `${API}/bookings/${booking.id}/review`,
          { rating: 1, comment: 'Muy mal' },
          booking.person.token,
        )
        .expect(201);
      for (let i = 0; i < 3; i++) {
        const reporter = await person();
        await reporter.client
          .post(`${API}/reviews/${review.body.id}/reports`, { reason: 'OFFENSIVE' }, reporter.token)
          .expect(204);
      }
      const agent = await staff();
      const queue = await agent.client
        .get(`${API}/admin/reviews/reported?limit=100`, agent.token)
        .expect(200);
      expect(queue.body.items.find((r: { id: string }) => r.id === review.body.id)).toMatchObject({
        status: 'UNDER_REVIEW',
        reviewReports: [{ reason: 'OFFENSIVE', count: 3 }],
        responseReports: [],
      });
      await agent.client
        .post(
          `${API}/admin/reviews/${review.body.id}/moderation`,
          { decision: 'HIDE' },
          agent.token,
        )
        .expect(400);
      const moderated = await agent.client
        .post(
          `${API}/admin/reviews/${review.body.id}/moderation`,
          { decision: 'HIDE', reason: 'Insultos' },
          agent.token,
        )
        .expect(200);
      expect(moderated.body).toEqual({ status: 'HIDDEN', resolvedReports: 3 });
      await agent.client
        .post(
          `${API}/admin/reviews/${review.body.id}/moderation`,
          { decision: 'KEEP', reason: 'x'.repeat(5) },
          agent.token,
        )
        .expect(409);
      // El autor de la valoración no la modera.
      await prisma.userRole.create({ data: { userId: booking.person.userId, role: 'SUPPORT' } });
      booking.person.token = await staffToken(app, booking.person);
      await booking.person.client
        .post(
          `${API}/admin/reviews/${review.body.id}/moderation`,
          { decision: 'RESTORE', reason: 'Es mía' },
          booking.person.token,
        )
        .expect(403);
      expect(app.get(ReviewModerationService)).toBeDefined();
    });
  });

  // ───────────── Solo ADMIN: ajustes y categorías ─────────────

  describe('ajustes y categorías (solo ADMIN)', () => {
    it('validación por clave, solo lectura y auditoría con el valor anterior y el nuevo', async () => {
      const admin = await staff('ADMIN');
      // charles_test no siembra ajustes (el código usa sus valores por defecto): se crean aquí con
      // esos mismos valores y se borran al terminar.
      const seeded = {
        'refunds.partial_percent': 50,
        'refunds.full_min_minutes': 300,
        'refunds.partial_min_minutes': 120,
        'availability.slot_interval_minutes': 15,
        'auth.lockout.ip_max_failures': 20,
        'payments.provider': 'FAKE',
        'reviews.window_days': 14,
      };
      const created: string[] = [];
      for (const [key, value] of Object.entries(seeded)) {
        if (await prisma.appSetting.findUnique({ where: { key } })) continue;
        await prisma.appSetting.create({ data: { key, value } });
        created.push(key);
      }
      try {
        const list = await admin.client.get(`${API}/admin/settings`, admin.token).expect(200);
        const byKey = new Map(list.body.map((s: { key: string }) => [s.key, s]));
        expect(byKey.get('refunds.partial_percent')).toMatchObject({
          editable: true,
          schema: { type: 'integer', min: 0, max: 100 },
        });
        expect(byKey.get('auth.lockout.ip_max_failures')).toMatchObject({
          editable: false,
          schema: null,
        });

        const put = (key: string, body: Record<string, unknown>) =>
          admin.client.put(`${API}/admin/settings/${key}`, body, admin.token);
        await put('refunds.partial_percent', { value: 101, reason: 'Prueba' }).expect(400);
        await put('refunds.partial_percent', { value: '50', reason: 'Prueba' }).expect(400);
        await put('refunds.partial_percent', { value: 60 }).expect(400);
        await put('availability.slot_interval_minutes', { value: 12, reason: 'Prueba' }).expect(
          400,
        );
        expect(
          (await put('auth.lockout.ip_max_failures', { value: 30, reason: 'Prueba' }).expect(403))
            .body.code,
        ).toBe('SETTING_READ_ONLY');
        await put('payments.provider', { value: 'FAKE', reason: 'Prueba' }).expect(403);
        await put('no.existe', { value: 1, reason: 'Prueba' }).expect(404);
        // Coherencia entre ajustes: la devolución parcial no puede exigir más anticipación que la total.
        await put('refunds.partial_min_minutes', { value: 400, reason: 'Prueba' }).expect(400);

        const before = (
          await prisma.appSetting.findUniqueOrThrow({ where: { key: 'reviews.window_days' } })
        ).value;
        try {
          const ok = await put('reviews.window_days', {
            value: 21,
            reason: 'Más tiempo para valorar',
          }).expect(200);
          expect(ok.body).toMatchObject({ key: 'reviews.window_days', value: 21, editable: true });
          const audit = await prisma.auditLog.findFirstOrThrow({
            where: { action: 'setting.updated', actorId: admin.userId },
            orderBy: { createdAt: 'desc' },
          });
          expect(audit.changes).toEqual({
            key: 'reviews.window_days',
            from: before,
            to: 21,
            reason: 'Más tiempo para valorar',
            actorRole: 'ADMIN',
          });
        } finally {
          await prisma.appSetting.update({
            where: { key: 'reviews.window_days' },
            data: { value: before as number },
          });
        }
      } finally {
        await prisma.appSetting.deleteMany({ where: { key: { in: created } } });
      }
    });

    it('categorías: crear, clave única, desactivar (nunca borrar) y salir de la lista pública', async () => {
      const admin = await staff('ADMIN');
      const key = `cat_${randomUUID().slice(0, 8)}`;
      const created = await admin.client
        .post(`${API}/admin/service-categories`, { key, name: 'Tinte', sortOrder: 50 }, admin.token)
        .expect(201);
      expect(created.body).toMatchObject({ key, name: 'Tinte', isActive: true, servicesCount: 0 });
      await admin.client
        .post(`${API}/admin/service-categories`, { key, name: 'Otra' }, admin.token)
        .expect(409);
      await admin.client
        .post(`${API}/admin/service-categories`, { key: 'Mal Clave', name: 'x' }, admin.token)
        .expect(400);
      const publicList = async () =>
        (await new AuthClient(app).get(`${API}/service-categories`).expect(200)).body.items.map(
          (c: { key: string }) => c.key,
        );
      expect(await publicList()).toContain(key);
      const off = await admin.client
        .patch(
          `${API}/admin/service-categories/${created.body.id}`,
          { isActive: false },
          admin.token,
        )
        .expect(200);
      expect(off.body.isActive).toBe(false);
      expect(await publicList()).not.toContain(key);
      expect(await prisma.serviceCategory.count({ where: { key } })).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { entityId: created.body.id, action: { startsWith: 'service_category.' } },
        }),
      ).toBe(2);
    });
  });
});
