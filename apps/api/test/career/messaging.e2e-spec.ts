import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { staffToken } from '../support/mfa';

/** Carrera del barbero: correo interno entre barberías y personas. */
describe('Correo interno (e2e)', () => {
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
  afterAll(() => app.close());

  it('el cliente escribe, la barbería responde; cifrado, no leídos y aviso sin contenido', async () => {
    const shop = await kit.shopReady();
    const client = await kit.verified();
    const started = await client.client
      .post(
        `${API}/me/conversations`,
        { barbershopId: shop.shopId, body: '¿Atienden niños?' },
        client.token,
      )
      .expect(201);
    const conversationId = started.body.conversation.id as string;
    expect(started.body.items[0]).toMatchObject({
      body: '¿Atienden niños?',
      mine: true,
      side: 'USER',
    });
    const raw = await prisma.message.findFirstOrThrow({ where: { conversationId } });
    expect(raw.bodyEnc).not.toContain('niños');

    // Escribir otra vez reutiliza la conversación.
    clock.current += 60_000;
    const again = await client.client
      .post(
        `${API}/me/conversations`,
        { barbershopId: shop.shopId, body: 'Tiene 6 años.' },
        client.token,
      )
      .expect(201);
    expect(again.body.conversation.id).toBe(conversationId);

    const inbox = await shop.owner.client
      .get(`${API}/barbershops/${shop.shopId}/conversations`, shop.owner.token)
      .expect(200);
    expect(inbox.body.items[0]).toMatchObject({ id: conversationId, kind: 'CLIENT', unread: 2 });
    const thread = await shop.owner.client
      .get(
        `${API}/barbershops/${shop.shopId}/conversations/${conversationId}/messages`,
        shop.owner.token,
      )
      .expect(200);
    expect(thread.body.items.map((m: { body: string }) => m.body)).toEqual([
      'Tiene 6 años.',
      '¿Atienden niños?',
    ]);
    expect(thread.body.conversation.unread).toBe(0);

    clock.current += 60_000;
    await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/conversations/${conversationId}/messages`,
        { body: 'Sí, desde los 3 años.' },
        shop.owner.token,
      )
      .expect(201);
    expect(
      (await client.client.get(`${API}/me/conversations/unread`, client.token).expect(200)).body,
    ).toEqual({
      conversations: 1,
    });

    // Avisos: push y bandeja; el correo no lleva el contenido.
    await app.get(OutboxRelay).relayBatch(500);
    const notices = await prisma.notification.findMany({
      where: { userId: client.userId, type: 'NEW_MESSAGE' },
    });
    expect(notices.length).toBeGreaterThan(0);
    expect(JSON.stringify(notices)).not.toContain('desde los 3 años');
  });

  it('nadie lee conversaciones ajenas; la barbería no escribe primero a clientes', async () => {
    const shop = await kit.shopReady();
    const client = await kit.verified();
    const started = await client.client
      .post(`${API}/me/conversations`, { barbershopId: shop.shopId, body: 'Hola' }, client.token)
      .expect(201);
    const stranger = await kit.verified();
    await stranger.client
      .get(`${API}/me/conversations/${started.body.conversation.id}/messages`, stranger.token)
      .expect(404);
    const otherShop = await kit.shopReady();
    await otherShop.owner.client
      .get(
        `${API}/barbershops/${otherShop.shopId}/conversations/${started.body.conversation.id}/messages`,
        otherShop.owner.token,
      )
      .expect(404);
    // A un cliente sin perfil profesional no se le escribe primero.
    await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/conversations`,
        { barberProfileId: client.userId, body: 'Promo' },
        shop.owner.token,
      )
      .expect(404);
  });

  it('bloquear impide escribir; solo quien bloqueó desbloquea', async () => {
    const shop = await kit.shopReady();
    const client = await kit.verified();
    const started = await client.client
      .post(`${API}/me/conversations`, { barbershopId: shop.shopId, body: 'Hola' }, client.token)
      .expect(201);
    const id = started.body.conversation.id as string;
    const shopPath = `${API}/barbershops/${shop.shopId}/conversations/${id}`;
    const blocked = await client.client
      .post(`${API}/me/conversations/${id}/block`, {}, client.token)
      .expect(200);
    expect(blocked.body).toMatchObject({ blocked: true, blockedByMe: true });
    const res = await shop.owner.client
      .post(`${shopPath}/messages`, { body: 'Hola?' }, shop.owner.token)
      .expect(409);
    expect(res.body.code).toBe('CONVERSATION_BLOCKED');
    await shop.owner.client.post(`${shopPath}/unblock`, {}, shop.owner.token).expect(403);
    await client.client.post(`${API}/me/conversations/${id}/unblock`, {}, client.token).expect(200);
    await shop.owner.client
      .post(`${shopPath}/messages`, { body: 'Ahora sí' }, shop.owner.token)
      .expect(201);
  });

  it('reportar un mensaje y retirarlo desde soporte', async () => {
    const shop = await kit.shopReady();
    const client = await kit.verified();
    const started = await client.client
      .post(`${API}/me/conversations`, { barbershopId: shop.shopId, body: 'Hola' }, client.token)
      .expect(201);
    const id = started.body.conversation.id as string;
    const offensive = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/conversations/${id}/messages`,
        { body: 'Texto ofensivo' },
        shop.owner.token,
      )
      .expect(201);
    // No se reporta un mensaje propio.
    await client.client
      .post(`${API}/messages/${started.body.items[0].id}/report`, { reason: 'SPAM' }, client.token)
      .expect(403);
    await client.client
      .post(`${API}/messages/${offensive.body.id}/report`, { reason: 'HARASSMENT' }, client.token)
      .expect(204);
    await client.client
      .post(`${API}/messages/${offensive.body.id}/report`, { reason: 'HARASSMENT' }, client.token)
      .expect(409);

    const support: Person = await kit.verified();
    await prisma.userRole.create({ data: { userId: support.userId, role: 'SUPPORT' } });
    support.token = await staffToken(app, support);
    const reports = await support.client
      .get(`${API}/admin/message-reports`, support.token)
      .expect(200);
    const report = reports.body.items.find(
      (r: { messageId: string }) => r.messageId === offensive.body.id,
    );
    expect(report).toMatchObject({ messageBody: 'Texto ofensivo', reason: 'HARASSMENT' });
    await support.client
      .post(
        `${API}/admin/message-reports/${report.id}/resolve`,
        { action: 'REMOVE', reason: 'Acoso verbal' },
        support.token,
      )
      .expect(204);
    const thread = await client.client
      .get(`${API}/me/conversations/${id}/messages`, client.token)
      .expect(200);
    expect(thread.body.items[0]).toMatchObject({
      removed: true,
      body: 'Mensaje retirado por soporte.',
    });
  });
});
