import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { FakeMailer } from '../../src/common/mail/fake-mailer';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { FAKE_SIGNATURE_HEADER, FakeGateway } from '../../src/modules/payments/fake-gateway';
import { devPay } from '../../src/scripts/dev-tools';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { FakePushSender } from '../../src/modules/notifications/push-sender';
import { REVIEW_RATE_LIMIT } from '../../src/modules/reviews/review-rate-limit';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, HOUR, lima, MONDAY } from '../support/bookings';

const TUESDAY = '2030-01-08';
const WEDNESDAY = '2030-01-09';
const DAY = 24 * HOUR;
const expoToken = (tag = '') => `ExponentPushToken[${tag}${randomBytes(12).toString('hex')}]`;

describe('RF-NOT-001…004 Notificaciones — Fase 10 (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  let notifications: NotificationsService;
  let push: FakePushSender;
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
    notifications = app.get(NotificationsService);
    push = app.get(FakePushSender);
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
    push.setUnavailable(false);
    REVIEW_RATE_LIMIT.set(1000);
  });
  afterAll(() => app.close());

  const relayAll = async () => {
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { availableAt: new Date(0) },
    });
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
  };
  const deliverAll = async () => {
    while ((await notifications.deliverDue()) > 0);
  };
  const rowsOf = (userId: string, type?: string) =>
    prisma.notification.findMany({
      where: { userId, ...(type ? { type } : {}) },
      orderBy: [{ createdAt: 'asc' }, { channel: 'asc' }],
    });
  const channelsOf = async (userId: string, type: string) =>
    (await rowsOf(userId, type)).map((r) => r.channel).sort();
  const registerDevice = async (who: { client: AuthClient; token: string }, token = expoToken()) =>
    (
      await who.client
        .put(
          `${API}/me/devices`,
          { pushToken: token, platform: 'ANDROID', appVersion: '1.0.0' },
          who.token,
        )
        .expect(200)
    ).body as { id: string };

  // ───────────── Dispositivos ─────────────

  describe('RF-NOT-001 dispositivos', () => {
    it('el token va en el cuerpo, se guarda cifrado e identificado por un ID propio', async () => {
      const me = await kit.verified();
      const token = expoToken();
      const device = await registerDevice(me, token);
      expect(device).toEqual({
        id: expect.any(String),
        platform: 'ANDROID',
        appVersion: '1.0.0',
        lastSeenAt: expect.any(String),
      });
      const again = await registerDevice(me, token);
      expect(again.id).toBe(device.id);
      const row = await prisma.deviceToken.findUniqueOrThrow({ where: { id: device.id } });
      expect(row.pushTokenEnc).not.toContain(token);
      expect(JSON.stringify(row)).not.toContain(token.slice(18, 30));
      const ios = await me.client
        .put(`${API}/me/devices`, { pushToken: expoToken(), platform: 'IOS' }, me.token)
        .expect(200);
      expect(ios.body).toMatchObject({ platform: 'IOS', appVersion: null });
      await me.client
        .put(`${API}/me/devices`, { pushToken: expoToken(), platform: 'WEB' }, me.token)
        .expect(400);
      const list = await me.client.get(`${API}/me/devices`, me.token).expect(200);
      expect(JSON.stringify(list.body)).not.toContain('ExponentPushToken');

      await me.client
        .put(`${API}/me/devices`, { pushToken: 'abc', platform: 'ANDROID' }, me.token)
        .expect(400);
      const other = await kit.verified();
      await other.client.delete(`${API}/me/devices/${device.id}`, other.token).expect(404);
      await me.client.delete(`${API}/me/devices/${device.id}`, me.token).expect(204);
      // Queda solo el de iOS.
      expect(await prisma.deviceToken.count({ where: { userId: me.userId } })).toBe(1);
      await new AuthClient(app).put(`${API}/me/devices`, {}).expect(401);
    });

    it('un token registrado por otra cuenta pasa a la nueva; máximo 10 por cuenta', async () => {
      const a = await kit.verified();
      const b = await kit.verified();
      const shared = expoToken();
      await registerDevice(a, shared);
      await registerDevice(b, shared);
      expect(await prisma.deviceToken.count({ where: { userId: a.userId } })).toBe(0);
      expect(await prisma.deviceToken.count({ where: { userId: b.userId } })).toBe(1);

      const first = await registerDevice(a);
      for (let i = 0; i < 10; i++) await registerDevice(a);
      const ids = (await prisma.deviceToken.findMany({ where: { userId: a.userId } })).map(
        (d) => d.id,
      );
      expect(ids).toHaveLength(10);
      expect(ids).not.toContain(first.id);
    });

    it('cerrar la sesión borra su dispositivo; cerrar todas, todos', async () => {
      const client = new AuthClient(app);
      const { email, password, tokens } = await client.newUser();
      const other = (await client.login(email, password).expect(200)).body as {
        accessToken: string;
      };
      await registerDevice({ client, token: tokens.accessToken });
      await registerDevice({ client, token: other.accessToken });
      await client
        .post(`${API}/auth/logout`, { allDevices: false }, tokens.accessToken)
        .expect(204);
      expect(await prisma.deviceToken.count({ where: { userId: tokens.user.id } })).toBe(1);
      await client.post(`${API}/auth/logout`, { allDevices: true }, other.accessToken).expect(204);
      expect(await prisma.deviceToken.count({ where: { userId: tokens.user.id } })).toBe(0);
    });
  });

  // ───────────── Avisos por evento ─────────────

  describe('RF-NOT-002 avisos de reservas', () => {
    it('reserva confirmada: cliente (push, bandeja, correo) y responsables (push y bandeja)', async () => {
      const shop = await kit.shopReady();
      const client = await kit.verified();
      await registerDevice(client);
      const booking = await kit.confirmed(shop, lima(WEDNESDAY, '12:00'), client);
      await relayAll();
      expect(await channelsOf(client.userId, 'BOOKING_CONFIRMED')).toEqual([
        'EMAIL',
        'IN_APP',
        'PUSH',
      ]);
      expect(await channelsOf(shop.owner.userId, 'NEW_BOOKING')).toEqual(['IN_APP', 'PUSH']);
      // Un evento repetido no duplica.
      await notifications.onEvent({
        id: (
          await prisma.outboxEvent.findFirstOrThrow({
            where: {
              type: 'booking.confirmed',
              payload: { path: ['bookingId'], equals: booking.id },
            },
          })
        ).id,
        type: 'booking.confirmed',
        payload: {
          bookingId: booking.id,
          status: 'CONFIRMED',
          from: 'PENDING_PAYMENT',
          actorRole: 'SYSTEM',
        },
      } as never);
      expect(await channelsOf(client.userId, 'BOOKING_CONFIRMED')).toHaveLength(3);

      await deliverAll();
      const sent = (await push.inbox()).filter(
        (p) => (p.data.resource as { id: string }).id === booking.id,
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        title: 'Reserva confirmada',
        body: 'Toca para ver los detalles.',
        data: { type: 'BOOKING_CONFIRMED', resource: { type: 'booking', id: booking.id } },
      });
      const mail = (await app.get(FakeMailer).inbox()).find(
        (m) => m.to === client.email && m.category === 'notification:BOOKING_CONFIRMED',
      );
      expect(mail?.text).toContain('Corte en Barbería E2E');
      const inApp = (await rowsOf(client.userId, 'BOOKING_CONFIRMED')).find(
        (r) => r.channel === 'IN_APP',
      )!;
      expect(inApp.body).toMatch(/Corte en Barbería E2E, miércoles 9 de enero a las 12:00/);
      expect(inApp.data).toEqual({
        type: 'BOOKING_CONFIRMED',
        resource: { type: 'booking', id: booking.id },
      });
      // El dueño sin dispositivos: su push queda omitido, no fallido.
      const ownerPush = (await rowsOf(shop.owner.userId, 'NEW_BOOKING')).find(
        (r) => r.channel === 'PUSH',
      )!;
      expect([ownerPush.status, ownerPush.lastError]).toEqual(['SKIPPED', 'NO_DEVICES']);
    });

    it('cancelación de la barbería: monto en bandeja y correo, nunca en el push; se envía aunque el cliente apague el correo', async () => {
      const shop = await kit.shopReady();
      const client = await kit.verified();
      await client.client
        .patch(
          `${API}/users/me`,
          { preferences: { notificationChannels: ['PUSH', 'IN_APP'] } },
          client.token,
        )
        .expect(200);
      await registerDevice(client);
      const booking = await kit.confirmed(shop, lima(WEDNESDAY, '12:00'), client);
      await shop.owner.client
        .post(
          `${API}/bookings/${booking.id}/cancel`,
          { reason: 'Barbero enfermo' },
          shop.owner.token,
        )
        .expect(200);
      await relayAll();
      // Confirmación (no obligatoria): sin correo. Cancelación de la barbería (pagos): con correo.
      expect(await channelsOf(client.userId, 'BOOKING_CONFIRMED')).toEqual(['IN_APP', 'PUSH']);
      expect(await channelsOf(client.userId, 'BOOKING_CANCELLED_BY_BARBERSHOP')).toEqual([
        'EMAIL',
        'IN_APP',
        'PUSH',
      ]);
      const rows = await rowsOf(client.userId, 'BOOKING_CANCELLED_BY_BARBERSHOP');
      const byChannel = new Map(rows.map((r) => [r.channel, r]));
      expect(byChannel.get('IN_APP')!.body).toContain('Te devolveremos S/ 25.00');
      expect(byChannel.get('EMAIL')!.body).toContain('S/ 25.00');
      expect(byChannel.get('PUSH')!.body).toBe('Toca para ver los detalles.');
      for (const row of rows) expect(row.body).not.toContain('enfermo');
    });

    it('cancelación del cliente: avisa a los responsables; inasistencia: al cliente en la bandeja', async () => {
      const shop = await kit.shopReady();
      const a = await kit.confirmed(shop, lima(WEDNESDAY, '12:00'));
      await a.person.client.post(`${API}/bookings/${a.id}/cancel`, {}, a.person.token).expect(200);
      const b = await kit.confirmed(shop, lima(MONDAY, '10:00'));
      clock.current = lima(MONDAY, '10:20');
      await shop.owner.client
        .post(`${API}/bookings/${b.id}/no-show`, {}, shop.owner.token)
        .expect(200);
      await relayAll();
      expect(await channelsOf(shop.owner.userId, 'BOOKING_CANCELLED_BY_CLIENT')).toEqual([
        'IN_APP',
        'PUSH',
      ]);
      expect(await channelsOf(a.person.userId, 'BOOKING_CANCELLED')).toEqual([
        'EMAIL',
        'IN_APP',
        'PUSH',
      ]);
      expect(await channelsOf(b.person.userId, 'NO_SHOW')).toEqual(['IN_APP']);
    });

    it('pago rechazado: push y bandeja, obligatorio', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.book(shop, lima(WEDNESDAY, '12:00'));
      await booking.person.client
        .patch(
          `${API}/users/me`,
          { preferences: { notificationChannels: [] } },
          booking.person.token,
        )
        .expect(200);
      await devPay(app, booking.id, 'REJECTED');
      await relayAll();
      expect(await channelsOf(booking.person.userId, 'PAYMENT_REJECTED')).toEqual([
        'IN_APP',
        'PUSH',
      ]);
    });
  });

  describe('RF-NOT-002 horario silencioso y preferencias', () => {
    it('de noche el push no urgente espera a las 08:00; el urgente sale ya; bandeja y correo no esperan', async () => {
      const shop = await kit.shopReady();
      const far = await kit.book(shop, lima(WEDNESDAY, '12:00'));
      const near = await kit.book(shop, lima(TUESDAY, '12:00'));
      clock.current = lima(MONDAY, '23:00');
      await devPay(app, far.id, 'SUCCEEDED');
      await devPay(app, near.id, 'SUCCEEDED');
      await relayAll();
      const pushOf = async (userId: string) =>
        (await rowsOf(userId, 'BOOKING_CONFIRMED')).find((r) => r.channel === 'PUSH')!;
      expect((await pushOf(far.person.userId)).sendAfter.getTime()).toBe(lima(TUESDAY, '08:00'));
      expect((await pushOf(near.person.userId)).sendAfter.getTime()).toBe(clock.current);
      const email = (await rowsOf(far.person.userId, 'BOOKING_CONFIRMED')).find(
        (r) => r.channel === 'EMAIL',
      )!;
      expect(email.sendAfter.getTime()).toBe(clock.current);
    });

    it('apagar el push quita los avisos no obligatorios por push', async () => {
      const shop = await kit.shopReady();
      const client = await kit.verified();
      await client.client
        .patch(
          `${API}/users/me`,
          { preferences: { notificationChannels: ['IN_APP'] } },
          client.token,
        )
        .expect(200);
      await kit.confirmed(shop, lima(WEDNESDAY, '12:00'), client);
      await relayAll();
      expect(await channelsOf(client.userId, 'BOOKING_CONFIRMED')).toEqual(['IN_APP']);
      const profile = await client.client.get(`${API}/users/me`, client.token).expect(200);
      expect(profile.body.preferences).toEqual({
        notificationChannels: ['IN_APP'],
        reminders: true,
      });
    });
  });

  // ───────────── Recordatorios ─────────────

  describe('RF-NOT-003 recordatorios', () => {
    it('24 h y 2 h antes, una sola vez cada uno; nunca de una reserva que ya empezó', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.confirmed(shop, lima(TUESDAY, '15:00'));
      await registerDevice(booking.person);
      const reminders = () => rowsOf(booking.person.userId, 'BOOKING_REMINDER');

      clock.current = lima(MONDAY, '14:59');
      await notifications.scanReminders();
      expect(await reminders()).toHaveLength(0);
      clock.current = lima(MONDAY, '15:00');
      await notifications.scanReminders();
      await notifications.scanReminders();
      expect((await reminders()).map((r) => r.channel).sort()).toEqual(['IN_APP', 'PUSH']);
      const inApp = (await reminders()).find((r) => r.channel === 'IN_APP')!;
      expect(inApp.title).toBe('Tu cita es mañana');

      clock.current = lima(TUESDAY, '13:00');
      await notifications.scanReminders();
      expect(await reminders()).toHaveLength(4);
      await deliverAll();
      expect(
        (await reminders()).filter((r) => r.channel === 'PUSH').every((r) => r.status === 'SENT'),
      ).toBe(true);

      clock.current = lima(TUESDAY, '15:00');
      expect(await notifications.scanReminders()).toBe(0);
    });

    it('si cae en el horario silencioso se adelanta (cita 09:00 → el de 2 h sale a las 21:59)', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.confirmed(shop, lima(TUESDAY, '09:00'));
      const count = async () => (await rowsOf(booking.person.userId, 'BOOKING_REMINDER')).length;
      clock.current = lima(MONDAY, '09:00');
      await notifications.scanReminders();
      expect(await count()).toBe(2); // el de 24 h
      clock.current = lima(MONDAY, '21:58');
      await notifications.scanReminders();
      expect(await count()).toBe(2);
      clock.current = lima(MONDAY, '21:59');
      await notifications.scanReminders();
      expect(await count()).toBe(4);
    });

    it('sin recordatorios si los apagó; un recordatorio pendiente de una reserva cancelada no sale', async () => {
      const shop = await kit.shopReady();
      const quiet = await kit.verified();
      await quiet.client
        .patch(
          `${API}/users/me`,
          { preferences: { notificationChannels: ['PUSH', 'IN_APP', 'EMAIL'], reminders: false } },
          quiet.token,
        )
        .expect(200);
      await kit.confirmed(shop, lima(TUESDAY, '15:00'), quiet);
      const other = await kit.confirmed(shop, lima(TUESDAY, '16:00'));
      await registerDevice(other.person);
      clock.current = lima(MONDAY, '16:00');
      await notifications.scanReminders();
      expect(await rowsOf(quiet.userId, 'BOOKING_REMINDER')).toHaveLength(0);
      expect(await rowsOf(other.person.userId, 'BOOKING_REMINDER')).toHaveLength(2);

      await other.person.client
        .post(`${API}/bookings/${other.id}/cancel`, {}, other.person.token)
        .expect(200);
      await deliverAll();
      const pushRow = (await rowsOf(other.person.userId, 'BOOKING_REMINDER')).find(
        (r) => r.channel === 'PUSH',
      )!;
      expect([pushRow.status, pushRow.lastError]).toEqual(['SKIPPED', 'NOT_APPLICABLE']);
    });
  });

  // ───────────── Entrega ─────────────

  describe('entrega push', () => {
    it('Expo marca un token inválido: se borra (en el envío o en el recibo)', async () => {
      const shop = await kit.shopReady();
      const client = await kit.verified();
      const bad = await registerDevice(client, expoToken('Invalid'));
      const good = await registerDevice(client);
      await kit.confirmed(shop, lima(WEDNESDAY, '12:00'), client);
      await relayAll();
      await deliverAll();
      expect(await prisma.deviceToken.findUnique({ where: { id: bad.id } })).toBeNull();
      const row = (await rowsOf(client.userId, 'BOOKING_CONFIRMED')).find(
        (r) => r.channel === 'PUSH',
      )!;
      expect(row.status).toBe('SENT');
      const ticketId = (row.providerData as { tickets: { ticketId: string }[] }).tickets[0]!
        .ticketId;
      push.failReceipt(ticketId);
      clock.current += 16 * 60_000;
      expect(await notifications.checkReceipts()).toBeGreaterThanOrEqual(1);
      expect(await prisma.deviceToken.findUnique({ where: { id: good.id } })).toBeNull();
    });

    it('Expo no responde: reintenta con espera y a los 5 intentos queda fallido', async () => {
      const shop = await kit.shopReady();
      const client = await kit.verified();
      await registerDevice(client);
      await kit.confirmed(shop, lima(WEDNESDAY, '12:00'), client);
      await relayAll();
      push.setUnavailable(true);
      const pushRow = async () =>
        (await rowsOf(client.userId, 'BOOKING_CONFIRMED')).find((r) => r.channel === 'PUSH')!;
      await deliverAll();
      let row = await pushRow();
      expect([row.status, row.attempts, row.lastError]).toEqual([
        'PENDING',
        1,
        'PROVIDER_UNAVAILABLE',
      ]);
      expect(row.sendAfter.getTime()).toBe(clock.current + 60_000);
      for (let i = 0; i < 4; i++) {
        clock.current += DAY;
        await deliverAll();
      }
      row = await pushRow();
      expect([row.status, row.attempts]).toEqual(['FAILED', 5]);
    });
  });

  // ───────────── Otros avisos ─────────────

  describe('RF-NOT-002 pagos, valoraciones, soporte y seguridad', () => {
    it('reembolso completado y fallido: bandeja y correo; el fallido queda para soporte', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.confirmed(shop, lima(WEDNESDAY, '12:00'));
      await booking.person.client
        .post(`${API}/bookings/${booking.id}/cancel`, {}, booking.person.token)
        .expect(200);
      await relayAll();
      const refund = await prisma.refund.findFirstOrThrow({
        where: { paymentId: booking.paymentId },
      });
      const webhook = app
        .get(FakeGateway)
        .settleRefund(
          { refundId: refund.id, paymentId: booking.paymentId, amount: refund.amount },
          'FAILED',
        );
      const sender = new AuthClient(app);
      await sender.http
        .post(`${API}/payments/webhooks/fake`)
        .set('X-Forwarded-For', sender.ip)
        .set('Content-Type', 'application/json')
        .set(FAKE_SIGNATURE_HEADER, webhook.signature)
        .send(webhook.rawBody)
        .expect(200);
      await relayAll();
      expect(await channelsOf(booking.person.userId, 'REFUND_FAILED')).toEqual(['EMAIL', 'IN_APP']);
      const admin = await kit.verified();
      await prisma.userRole.create({ data: { userId: admin.userId, role: 'SUPPORT' } });
      const failed = await admin.client
        .get(`${API}/admin/refunds/failed?limit=100`, admin.token)
        .expect(200);
      expect(failed.body.items.map((r: { id: string }) => r.id)).toContain(refund.id);
    });

    it('nueva valoración (barbería, bandeja); respuesta de soporte (push y bandeja, nunca por nota interna)', async () => {
      const shop = await kit.shopReady();
      const booking = await kit.attended(shop, lima(MONDAY, '10:00'));
      const review = await booking.person.client
        .post(`${API}/bookings/${booking.id}/review`, { rating: 4 }, booking.person.token)
        .expect(201);
      const ticket = await booking.person.client
        .post(
          `${API}/support/tickets`,
          { category: 'OTHER', subject: 'Consulta', message: 'Hola' },
          booking.person.token,
        )
        .expect(201);
      const agent = await kit.verified();
      await prisma.userRole.create({ data: { userId: agent.userId, role: 'SUPPORT' } });
      await agent.client
        .post(
          `${API}/admin/tickets/${ticket.body.id}/messages`,
          { body: 'Interna', isInternal: true },
          agent.token,
        )
        .expect(201);
      await relayAll();
      expect(await rowsOf(booking.person.userId, 'SUPPORT_REPLY')).toHaveLength(0);
      await agent.client
        .post(`${API}/admin/tickets/${ticket.body.id}/messages`, { body: 'Respuesta' }, agent.token)
        .expect(201);
      await relayAll();
      expect(await channelsOf(shop.owner.userId, 'NEW_REVIEW')).toEqual(['IN_APP']);
      const reviewRow = (await rowsOf(shop.owner.userId, 'NEW_REVIEW'))[0]!;
      expect(reviewRow.data).toEqual({
        type: 'NEW_REVIEW',
        resource: { type: 'review', id: review.body.id },
      });
      expect(await channelsOf(booking.person.userId, 'SUPPORT_REPLY')).toEqual(['IN_APP', 'PUSH']);
    });

    it('cuenta deshabilitada (solo correo) y barbería suspendida (correo y bandeja)', async () => {
      const shop = await kit.shopReady();
      const target = await kit.verified();
      const agent = await kit.verified();
      await prisma.userRole.create({ data: { userId: agent.userId, role: 'SUPPORT' } });
      await agent.client
        .post(`${API}/admin/users/${target.userId}/disable`, { reason: 'Fraude' }, agent.token)
        .expect(200);
      await agent.client
        .post(
          `${API}/admin/barbershops/${shop.shopId}/suspend`,
          { reason: 'Reportes' },
          agent.token,
        )
        .expect(200);
      await relayAll();
      expect(await channelsOf(target.userId, 'ACCOUNT_DISABLED')).toEqual(['EMAIL']);
      expect(await channelsOf(shop.owner.userId, 'BARBERSHOP_SUSPENDED')).toEqual([
        'EMAIL',
        'IN_APP',
      ]);
      await deliverAll();
      const mail = (await app.get(FakeMailer).inbox()).find(
        (m) => m.to === target.email && m.category === 'notification:ACCOUNT_DISABLED',
      );
      expect(mail?.text).not.toContain('Fraude');
    });
  });

  it('eventos incompletos o de recursos inexistentes no generan avisos', async () => {
    const before = await prisma.notification.count();
    const id = '00000000-0000-7000-8000-00000000000a';
    for (const [type, payload] of [
      ['booking.confirmed', {}],
      ['booking.confirmed', { bookingId: id }],
      ['refund.succeeded', { refundId: id }],
      ['review.created', {}],
      ['ticket.replied', { ticketId: id }],
      ['user.disabled', {}],
      ['barbershop.suspended', { barbershopId: id }],
      ['barbershop.suspended', {}],
      ['otro.evento', {}],
    ] as const) {
      await notifications.onEvent({ id: `${type}-${Math.random()}`, type, payload } as never);
    }
    expect(await prisma.notification.count()).toBe(before);
  });

  // ───────────── Bandeja ─────────────

  describe('RF-NOT-004 bandeja', () => {
    it('lista, contador, marcar leído (uno y todos), solo lo propio; se conserva 90 días', async () => {
      const shop = await kit.shopReady();
      const client = await kit.verified();
      await kit.confirmed(shop, lima(WEDNESDAY, '12:00'), client);
      await kit.confirmed(shop, lima(WEDNESDAY, '13:00'), client);
      await relayAll();
      const inbox = await client.client.get(`${API}/me/notifications`, client.token).expect(200);
      expect(inbox.body.items).toHaveLength(2);
      expect(inbox.body.items[0]).toEqual({
        id: expect.any(String),
        type: 'BOOKING_CONFIRMED',
        title: 'Reserva confirmada',
        body: expect.stringContaining('13:00'),
        resource: { type: 'booking', id: expect.any(String) },
        createdAt: expect.any(String),
        readAt: null,
      });
      const count = () =>
        client.client.get(`${API}/me/notifications/unread-count`, client.token).expect(200);
      expect((await count()).body).toEqual({ unread: 2 });
      const page = await client.client
        .get(`${API}/me/notifications?limit=1`, client.token)
        .expect(200);
      const next = await client.client
        .get(`${API}/me/notifications?limit=1&cursor=${page.body.nextCursor}`, client.token)
        .expect(200);
      expect(next.body.items[0].id).toBe(inbox.body.items[1].id);
      expect(next.body.nextCursor).toBeNull();
      const first = inbox.body.items[0].id as string;
      const other = await kit.verified();
      await other.client.post(`${API}/me/notifications/${first}/read`, {}, other.token).expect(404);
      await client.client
        .post(`${API}/me/notifications/${first}/read`, {}, client.token)
        .expect(204);
      expect((await count()).body).toEqual({ unread: 1 });
      const unreadOnly = await client.client
        .get(`${API}/me/notifications?unreadOnly=true`, client.token)
        .expect(200);
      expect(unreadOnly.body.items).toHaveLength(1);
      expect(
        (await client.client.post(`${API}/me/notifications/read-all`, {}, client.token).expect(200))
          .body,
      ).toEqual({ updated: 1 });
      expect((await count()).body).toEqual({ unread: 0 });

      clock.current += 91 * DAY;
      await notifications.purgeOld();
      expect(
        (await client.client.get(`${API}/me/notifications`, client.token).expect(200)).body.items,
      ).toEqual([]);
    });
  });
});
