import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TicketsService } from '../../src/modules/support/tickets.service';
import { REVIEW_RATE_LIMIT } from '../../src/modules/reviews/review-rate-limit';
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

const DAY = 24 * HOUR;

describe('RF-SOP-001…003 Tickets de soporte y reportes de barberías — Fase 12 (e2e)', () => {
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

  async function staff(role: 'SUPPORT' | 'ADMIN' = 'SUPPORT'): Promise<Person> {
    const p = await person();
    await prisma.userRole.create({ data: { userId: p.userId, role } });
    return p;
  }

  const newTicket = (who: Person, body: Record<string, unknown> = {}) =>
    who.client.post(
      `${API}/support/tickets`,
      {
        category: 'BOOKING',
        subject: 'No me llegó la confirmación',
        message: 'Hola, ayuda',
        ...body,
      },
      who.token,
    );

  describe('RF-SOP-001 el usuario abre y sigue sus tickets', () => {
    it('crea con relación propia; mensajes cifrados; ve solo lo suyo y nunca notas internas', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.book(shop, lima(MONDAY, '12:00'));
      const me = booking.person;
      const created = await newTicket(
        { ...me },
        {
          relatedType: 'booking',
          relatedId: booking.id,
          message: 'Pagué y sigue pendiente',
        },
      ).expect(201);
      expect(created.body).toEqual(
        expect.objectContaining({
          status: 'OPEN',
          category: 'BOOKING',
          related: { type: 'booking', id: booking.id },
          canReply: true,
          messages: [expect.objectContaining({ body: 'Pagué y sigue pendiente', from: 'USER' })],
        }),
      );
      const ticketId = created.body.id as string;
      const stored = await prisma.ticketMessage.findFirstOrThrow({ where: { ticketId } });
      expect(stored.bodyEnc).not.toContain('Pagué');
      expect(stored.bodyEnc).toMatch(/^v\d+:/);

      // Soporte responde y deja una nota interna.
      const agent = await staff();
      await agent.client
        .post(
          `${API}/admin/tickets/${ticketId}/messages`,
          { body: 'Nota: revisar pasarela', isInternal: true },
          agent.token,
        )
        .expect(201);
      expect(
        (await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } })).status,
      ).toBe('OPEN');
      const reply = await agent.client
        .post(`${API}/admin/tickets/${ticketId}/messages`, { body: 'Ya lo revisamos' }, agent.token)
        .expect(201);
      expect(reply.body).toEqual(
        expect.objectContaining({
          status: 'IN_PROGRESS',
          assignedTo: { id: agent.userId, fullName: expect.any(String) },
        }),
      );
      expect(reply.body.messages.map((m: { isInternal: boolean }) => m.isInternal)).toEqual([
        false,
        true,
        false,
      ]);

      const view = await me.client
        .get(`${API}/me/support/tickets/${ticketId}`, me.token)
        .expect(200);
      expect(
        view.body.messages.map((m: { body: string; from: string }) => [m.from, m.body]),
      ).toEqual([
        ['USER', 'Pagué y sigue pendiente'],
        ['SUPPORT', 'Ya lo revisamos'],
      ]);
      expect(JSON.stringify(view.body)).not.toMatch(/Nota: revisar|isInternal|author/);
      const list = await me.client.get(`${API}/me/support/tickets`, me.token).expect(200);
      expect(list.body.items.map((t: { id: string }) => t.id)).toEqual([ticketId]);

      // Otro usuario no lo ve ni responde.
      const other = await person();
      await other.client.get(`${API}/me/support/tickets/${ticketId}`, other.token).expect(404);
      await other.client
        .post(`${API}/me/support/tickets/${ticketId}/messages`, { body: 'hola' }, other.token)
        .expect(404);
      await new AuthClient(app).post(`${API}/support/tickets`, {}).expect(401);
    });

    it('la relación debe ser propia; validación; máximo de tickets abiertos', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.book(shop, lima(MONDAY, '12:00'));
      const me = await person();
      await newTicket(me, { relatedType: 'booking', relatedId: booking.id }).expect(404);
      await newTicket(me, { relatedType: 'barbershop', relatedId: shop.shopId }).expect(404);
      await newTicket(me, { relatedType: 'payment', relatedId: booking.paymentId }).expect(404);
      await newTicket(me, { relatedType: 'booking' }).expect(400);
      await newTicket(me, { subject: 'ab' }).expect(400);
      await newTicket(me, { category: 'NOPE' }).expect(400);
      // El cliente sí puede relacionar su pago; la barbería, su barbería.
      await newTicket(booking.person, {
        relatedType: 'payment',
        relatedId: booking.paymentId,
      }).expect(201);
      await newTicket(
        {
          client: shop.owner.client,
          token: shop.owner.token,
          userId: shop.owner.userId,
          email: '',
        },
        { relatedType: 'barbershop', relatedId: shop.shopId, category: 'BARBERSHOP' },
      ).expect(201);

      for (let i = 0; i < 5; i++) await newTicket(me).expect(201);
      const limited = await newTicket(me).expect(429);
      expect(limited.body.details).toEqual([{ maxOpen: 5 }]);
    });
  });

  describe('RF-SOP-002/003 soporte atiende la cola', () => {
    it('recorrido completo: tomar, resolver, reabrir respondiendo dentro de 7 días, cierre', async () => {
      const me = await person();
      const ticketId = (await newTicket(me).expect(201)).body.id as string;
      const agent = await staff();
      const other = await staff();

      const queue = await agent.client
        .get(`${API}/admin/tickets?assigned=unassigned&limit=100`, agent.token)
        .expect(200);
      expect(queue.body.items.map((t: { id: string }) => t.id)).toContain(ticketId);
      expect(queue.body.items.find((t: { id: string }) => t.id === ticketId).requester).toEqual({
        id: me.userId,
        fullName: expect.any(String),
      });

      const taken = await agent.client
        .post(`${API}/admin/tickets/${ticketId}/assign`, {}, agent.token)
        .expect(200);
      expect(taken.body).toEqual(
        expect.objectContaining({
          status: 'IN_PROGRESS',
          assignedTo: expect.objectContaining({ id: agent.userId }),
        }),
      );
      // Reasignar a otra cuenta de soporte; nunca a una cuenta que no es de soporte.
      await agent.client
        .post(`${API}/admin/tickets/${ticketId}/assign`, { assigneeId: me.userId }, agent.token)
        .expect(400);
      await agent.client
        .post(`${API}/admin/tickets/${ticketId}/assign`, { assigneeId: other.userId }, agent.token)
        .expect(200);
      const mine = await other.client
        .get(`${API}/admin/tickets?assigned=me`, other.token)
        .expect(200);
      expect(mine.body.items.map((t: { id: string }) => t.id)).toContain(ticketId);

      // Transición inválida y cierre sin motivo.
      await agent.client
        .patch(`${API}/admin/tickets/${ticketId}/status`, { status: 'OPEN' }, agent.token)
        .expect(400);
      await agent.client
        .patch(`${API}/admin/tickets/${ticketId}/status`, { status: 'CLOSED' }, agent.token)
        .expect(400);

      await agent.client
        .patch(`${API}/admin/tickets/${ticketId}/status`, { status: 'RESOLVED' }, agent.token)
        .expect(200);
      // El usuario responde dentro del plazo: se reabre.
      clock.current += 7 * DAY;
      const reopened = await me.client
        .post(`${API}/me/support/tickets/${ticketId}/messages`, { body: 'Sigue igual' }, me.token)
        .expect(201);
      expect(reopened.body.status).toBe('IN_PROGRESS');
      // Resuelto de nuevo; pasado el plazo ya no se reabre.
      await agent.client
        .patch(`${API}/admin/tickets/${ticketId}/status`, { status: 'RESOLVED' }, agent.token)
        .expect(200);
      clock.current += 7 * DAY + 1;
      const late = await me.client
        .post(`${API}/me/support/tickets/${ticketId}/messages`, { body: 'Hola?' }, me.token)
        .expect(409);
      expect(late.body.code).toBe('TICKET_CLOSED');
      expect(
        (await me.client.get(`${API}/me/support/tickets/${ticketId}`, me.token)).body.canReply,
      ).toBe(false);

      // El cierre automático lo cierra; cerrado es final.
      clock.current += DAY;
      expect(await app.get(TicketsService).autoCloseResolved()).toBeGreaterThanOrEqual(1);
      const closed = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
      expect(closed.status).toBe('CLOSED');
      expect(closed.closedAt).not.toBeNull();
      await agent.client
        .patch(`${API}/admin/tickets/${ticketId}/status`, { status: 'IN_PROGRESS' }, agent.token)
        .expect(409);
      await agent.client
        .post(`${API}/admin/tickets/${ticketId}/messages`, { body: 'x' }, agent.token)
        .expect(409);

      const audit = await prisma.auditLog.findMany({
        where: { entityId: ticketId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual([
        'ticket.assigned',
        'ticket.assigned',
        'ticket.status_changed',
        'ticket.reopened',
        'ticket.status_changed',
        'ticket.auto_closed',
      ]);
    });

    it('cerrar sin resolver exige motivo y queda auditado', async () => {
      const me = await person();
      const ticketId = (await newTicket(me).expect(201)).body.id as string;
      const agent = await staff();
      await agent.client
        .patch(
          `${API}/admin/tickets/${ticketId}/status`,
          { status: 'CLOSED', reason: 'Duplicado' },
          agent.token,
        )
        .expect(200);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: ticketId, action: 'ticket.status_changed' },
      });
      expect(audit.changes).toMatchObject({ reason: 'Duplicado', actorRole: 'SUPPORT' });
    });

    it('conflicto de interés: ni tickets propios ni de una barbería propia', async () => {
      const agent = await staff();
      const own = (await newTicket(agent).expect(201)).body.id as string;
      const queue = await agent.client
        .get(`${API}/admin/tickets?limit=100`, agent.token)
        .expect(200);
      expect(queue.body.items.map((t: { id: string }) => t.id)).not.toContain(own);
      const res = await agent.client.get(`${API}/admin/tickets/${own}`, agent.token).expect(403);
      expect(res.body.code).toBe('CONFLICT_OF_INTEREST');

      // El agente es miembro de una barbería: no atiende tickets relacionados con ella.
      const shop = await kit.shopReady();
      await prisma.barbershopMember.create({
        data: { barbershopId: shop.shopId, userId: agent.userId, role: 'MANAGER' },
      });
      const booking = await kit.book(shop, lima(MONDAY, '12:00'));
      const related = (
        await newTicket(booking.person, { relatedType: 'booking', relatedId: booking.id }).expect(
          201,
        )
      ).body.id as string;
      expect(
        (
          await agent.client
            .post(`${API}/admin/tickets/${related}/assign`, {}, agent.token)
            .expect(403)
        ).body.code,
      ).toBe('CONFLICT_OF_INTEREST');
      // Nadie asigna un ticket a quien lo abrió.
      const another = await staff();
      const fromStaff = (await newTicket(another).expect(201)).body.id as string;
      await agent.client
        .post(
          `${API}/admin/tickets/${fromStaff}/assign`,
          { assigneeId: another.userId },
          agent.token,
        )
        .expect(403);
    });
  });

  describe('cuenta deshabilitada: acceso limitado a soporte', () => {
    it('obtiene una sesión restringida que solo sirve para sus tickets', async () => {
      const client = new AuthClient(app);
      const { email, password, tokens } = await client.newUser();
      await prisma.user.update({ where: { id: tokens.user.id }, data: { status: 'DISABLED' } });

      expect((await client.login(email, password).expect(403)).body.code).toBe('ACCOUNT_DISABLED');
      await client
        .post(`${API}/auth/support-access`, { email, password: 'incorrecta-123' })
        .expect(401);
      const access = await client
        .post(`${API}/auth/support-access`, { email, password })
        .expect(200);
      expect(access.body).toEqual({
        tokenType: 'Bearer',
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(String),
        restricted: true,
        scope: 'support',
      });
      expect(access.body).not.toHaveProperty('refreshToken');
      const token = access.body.accessToken as string;

      const ticket = await client
        .post(
          `${API}/support/tickets`,
          { category: 'ACCOUNT', subject: 'Mi cuenta', message: '¿Por qué?' },
          token,
        )
        .expect(201);
      await client.get(`${API}/me/support/tickets`, token).expect(200);
      await client.get(`${API}/me/support/tickets/${ticket.body.id}`, token).expect(200);
      for (const path of ['/users/me', '/me/bookings', '/me/favorites']) {
        const denied = await client.get(`${API}${path}`, token).expect(403);
        expect(denied.body.code).toBe('ACCOUNT_DISABLED');
      }
      // Tampoco entra a /admin aunque la cuenta tuviera roles de soporte.
      await prisma.userRole.create({ data: { userId: tokens.user.id, role: 'SUPPORT' } });
      await client.get(`${API}/admin/tickets`, token).expect(403);
      expect(
        await prisma.auditLog.count({
          where: { action: 'auth.support_access', entityId: tokens.user.id },
        }),
      ).toBe(1);
    });

    it('una cuenta activa usa el inicio de sesión normal', async () => {
      const client = new AuthClient(app);
      const { email, password } = await client.newUser();
      await client.post(`${API}/auth/support-access`, { email, password }).expect(409);
    });
  });

  describe('reportes de barberías', () => {
    it('cualquier cuenta reporta una vez; los miembros no; soporte lo ve y lo resuelve', async () => {
      const shop = await kit.shopReady();
      const a = await person();
      const b = await person();
      const report = (who: { client: AuthClient; token: string }, body: Record<string, unknown>) =>
        who.client.post(`${API}/barbershops/${shop.shopId}/reports`, body, who.token);
      await report(a, { reason: 'MISLEADING_INFO', details: 'Precios distintos' }).expect(204);
      expect((await report(a, { reason: 'FRAUD' }).expect(409)).body.code).toBe('ALREADY_REPORTED');
      await report(b, { reason: 'NOPE' }).expect(400);
      await report(b, { reason: 'NOT_OPERATING' }).expect(204);
      await report(shop.owner, { reason: 'FRAUD' }).expect(403);
      await a.client
        .post(`${API}/barbershops/${randomUUID()}/reports`, { reason: 'FRAUD' }, a.token)
        .expect(404);

      const agent = await staff();
      const listed = await agent.client
        .get(`${API}/admin/barbershops?limit=100`, agent.token)
        .expect(200);
      expect(listed.body.items.find((s: { id: string }) => s.id === shop.shopId)).toEqual(
        expect.objectContaining({ openReports: 2, status: 'OPEN' }),
      );
      const detail = await agent.client
        .get(`${API}/admin/barbershops/${shop.shopId}`, agent.token)
        .expect(200);
      expect(detail.body.reports.map((r: { reason: string }) => r.reason)).toEqual([
        'MISLEADING_INFO',
        'NOT_OPERATING',
      ]);
      expect(JSON.stringify(detail.body)).not.toContain(a.userId);
      const resolved = await agent.client
        .post(
          `${API}/admin/barbershops/${shop.shopId}/reports/resolve`,
          { resolution: 'Se corrigieron los precios' },
          agent.token,
        )
        .expect(200);
      expect(resolved.body.openReports).toBe(0);
      const rows = await prisma.barbershopReport.findMany({ where: { barbershopId: shop.shopId } });
      expect(rows.every((r) => r.status === 'RESOLVED' && r.resolvedById === agent.userId)).toBe(
        true,
      );
    });
  });
});
