import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { staffToken } from '../support/mfa';

/** Comunidad: publicaciones, feed, comentarios, me gusta, seguir, eventos, bloqueos y moderación. */
describe('Comunidad (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  let boss: Person;
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
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    boss = { client, token: tokens.accessToken, userId: tokens.user.id, email };
    await prisma.userRole.create({ data: { userId: boss.userId, role: 'ADMIN' } });
    boss.token = await staffToken(app, boss);
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
  });
  afterAll(async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'community.blocked_words' } });
    await app.close();
  });

  const photo = () =>
    sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer();

  /** Entrega los avisos pendientes del outbox. */
  async function deliver(): Promise<void> {
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
    await app.get(NotificationsService).deliverDue();
  }

  it('publicar como barbería con fotos; feed público, "cerca de ti", por autor y página para compartir', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const upload = await o.client.http
      .post(`${API}/posts/media`)
      .set('Authorization', `Bearer ${o.token}`)
      .set('X-Forwarded-For', o.client.ip)
      .attach('file', await photo(), 'corte.jpg')
      .expect(201);
    expect(upload.body.url).toBeTruthy();

    await o.client
      .post(
        `${API}/posts`,
        { type: 'EVENT', barbershopId: shop.shopId, body: 'Sin datos' },
        o.token,
      )
      .expect(400);
    const post = await o.client
      .post(
        `${API}/posts`,
        {
          type: 'ANNOUNCEMENT',
          barbershopId: shop.shopId,
          body: 'Nuevo horario los domingos',
          mediaIds: [upload.body.id],
        },
        o.token,
      )
      .expect(201);
    expect(post.body).toMatchObject({
      type: 'ANNOUNCEMENT',
      author: { kind: 'BARBERSHOP', id: shop.shopId, followers: 0 },
      counts: { likes: 0, comments: 0, shares: 0 },
      canEdit: true,
      canDelete: true,
      canPin: true,
    });
    expect(post.body.media).toHaveLength(1);
    // La misma foto no se adjunta a otra publicación.
    await o.client
      .post(
        `${API}/posts`,
        {
          type: 'ANNOUNCEMENT',
          barbershopId: shop.shopId,
          body: 'Otra',
          mediaIds: [upload.body.id],
        },
        o.token,
      )
      .expect(400);

    const anon = new AuthClient(app);
    const feed = await anon.get(`${API}/feed`).expect(200);
    const mine = feed.body.items.find((p: { id: string }) => p.id === post.body.id);
    expect(mine).toMatchObject({ likedByMe: false, canEdit: false });
    await anon.get(`${API}/feed?tab=nearby`).expect(400);
    const near = await anon
      .get(`${API}/feed?tab=nearby&lat=-12.12&lng=-77.03&radiusKm=5`)
      .expect(200);
    const nearPost = near.body.items.find((p: { id: string }) => p.id === post.body.id);
    expect(nearPost.distanceKm).toBeLessThanOrEqual(5);
    const byShop = await anon.get(`${API}/barbershops/${shop.shopId}/posts`).expect(200);
    expect(byShop.body.items.map((p: { id: string }) => p.id)).toContain(post.body.id);

    const page = await anon.http.get(`${API}/p/${post.body.id}`).expect(200);
    expect(page.text).toContain('og:title');
    expect(page.text).toContain('Nuevo horario los domingos');
    const shared = await anon.post(`${API}/posts/${post.body.id}/share`, {}).expect(200);
    expect(shared.body.shares).toBe(1);

    // Un cliente cualquiera no puede publicar por la barbería ni editar.
    const stranger = await kit.verified();
    await stranger.client
      .post(
        `${API}/posts`,
        { type: 'ANNOUNCEMENT', barbershopId: shop.shopId, body: 'Hola' },
        stranger.token,
      )
      .expect(404);
    await stranger.client
      .patch(`${API}/posts/${post.body.id}`, { body: 'x' }, stranger.token)
      .expect(404);
    const edited = await o.client
      .patch(`${API}/posts/${post.body.id}`, { body: 'Horario nuevo' }, o.token)
      .expect(200);
    expect(edited.body.editedAt).not.toBeNull();
  });

  it('me gusta, guardar, seguir y feed "siguiendo"; comentarios en 2 niveles con mención', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const post = await o.client
      .post(
        `${API}/posts`,
        { type: 'PROMOTION', barbershopId: shop.shopId, body: '20 % los martes' },
        o.token,
      )
      .expect(201);
    const ana = await kit.verified();
    const luis = await kit.verified();

    const liked = await ana.client
      .put(`${API}/posts/${post.body.id}/like`, {}, ana.token)
      .expect(200);
    expect(liked.body).toEqual({ liked: true, likes: 1 });
    expect(
      (await ana.client.put(`${API}/posts/${post.body.id}/like`, {}, ana.token).expect(200)).body
        .likes,
    ).toBe(1);
    await luis.client.put(`${API}/posts/${post.body.id}/like`, {}, luis.token).expect(200);
    expect(
      (await luis.client.delete(`${API}/posts/${post.body.id}/like`, luis.token).expect(200)).body
        .likes,
    ).toBe(1);

    await ana.client.put(`${API}/posts/${post.body.id}/save`, {}, ana.token).expect(200);
    const saved = await ana.client.get(`${API}/me/saved-posts`, ana.token).expect(200);
    expect(saved.body.items.map((p: { id: string }) => p.id)).toEqual([post.body.id]);

    expect(
      (await ana.client.get(`${API}/feed?tab=following`, ana.token).expect(200)).body.items,
    ).toHaveLength(0);
    const follow = await ana.client
      .put(`${API}/barbershops/${shop.shopId}/follow`, {}, ana.token)
      .expect(200);
    expect(follow.body).toEqual({ following: true, followers: 1 });
    const following = await ana.client.get(`${API}/feed?tab=following`, ana.token).expect(200);
    expect(following.body.items[0]).toMatchObject({
      id: post.body.id,
      likedByMe: true,
      savedByMe: true,
      followingAuthor: true,
    });

    const top = await ana.client
      .post(`${API}/posts/${post.body.id}/comments`, { body: '¿Aplica a niños?' }, ana.token)
      .expect(201);
    const reply = await o.client
      .post(
        `${API}/posts/${post.body.id}/comments`,
        { body: 'Sí, a todos', parentId: top.body.id },
        o.token,
      )
      .expect(201);
    expect(reply.body).toMatchObject({ authorIsOfficial: true, parentId: top.body.id });
    // Responder a una respuesta: mismo padre + mención (un tercer nivel no se permite).
    await luis.client
      .post(
        `${API}/posts/${post.body.id}/comments`,
        { body: 'Gracias', parentId: reply.body.id },
        luis.token,
      )
      .expect(400);
    const mention = await luis.client
      .post(
        `${API}/posts/${post.body.id}/comments`,
        { body: 'Gracias', parentId: top.body.id, mentionUserId: o.userId },
        luis.token,
      )
      .expect(201);
    expect(mention.body.mention.userId).toBe(o.userId);

    const list = await ana.client
      .get(`${API}/posts/${post.body.id}/comments`, ana.token)
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ replies: 2, canEdit: true, canPin: false });
    const replies = await ana.client
      .get(`${API}/posts/${post.body.id}/comments?parentId=${top.body.id}`, ana.token)
      .expect(200);
    expect(replies.body.items).toHaveLength(2);
    expect(
      (await ana.client.put(`${API}/comments/${reply.body.id}/like`, {}, ana.token).expect(200))
        .body.likes,
    ).toBe(1);
    const pinned = await o.client
      .put(`${API}/comments/${top.body.id}/pin`, { pinned: true }, o.token)
      .expect(200);
    expect(pinned.body.pinned).toBe(true);
    // El autor de la publicación borra un comentario ajeno; el contador baja.
    await o.client.delete(`${API}/comments/${mention.body.id}`, o.token).expect(204);
    const one = await ana.client.get(`${API}/posts/${post.body.id}`, ana.token).expect(200);
    expect(one.body.counts.comments).toBe(2);

    await o.client
      .patch(`${API}/posts/${post.body.id}`, { commentsDisabled: true }, o.token)
      .expect(200);
    const disabled = await ana.client
      .post(`${API}/posts/${post.body.id}/comments`, { body: 'Hola' }, ana.token)
      .expect(409);
    expect(disabled.body.code).toBe('COMMENTS_DISABLED');

    // Avisos: comentario, respuesta, mención y me gusta agrupados.
    await deliver();
    const types = (
      await prisma.notification.findMany({
        where: { userId: { in: [o.userId, ana.userId] }, channel: 'IN_APP' },
        select: { type: true },
      })
    ).map((n) => n.type);
    expect(types).toEqual(
      expect.arrayContaining(['COMMUNITY_COMMENT', 'COMMUNITY_REPLY', 'COMMUNITY_LIKE']),
    );
  });

  it('eventos con cupo, perfil profesional, bloqueos, filtro de palabras, reportes y revisión', async () => {
    const barber = await kit.verified();
    await barber.client
      .put(
        `${API}/me/barber-profile`,
        { displayName: 'Rocío Fades', ubigeo: '150122' },
        barber.token,
      )
      .expect(200);
    const event = await barber.client
      .post(
        `${API}/posts`,
        {
          type: 'EVENT',
          body: 'Taller de fades gratis',
          event: {
            startsAt: new Date(lima(MONDAY, '18:00')).toISOString(),
            address: 'Av. Prueba 123',
            capacity: 1,
          },
        },
        barber.token,
      )
      .expect(201);
    expect(event.body.author.kind).toBe('PROFESSIONAL');
    const a = await kit.verified();
    const b = await kit.verified();
    expect(
      (
        await a.client
          .put(`${API}/posts/${event.body.id}/attendance`, { status: 'GOING' }, a.token)
          .expect(200)
      ).body.going,
    ).toBe(1);
    const full = await b.client
      .put(`${API}/posts/${event.body.id}/attendance`, { status: 'GOING' }, b.token)
      .expect(409);
    expect(full.body.code).toBe('EVENT_FULL');
    expect(
      (
        await b.client
          .put(`${API}/posts/${event.body.id}/attendance`, { status: 'INTERESTED' }, b.token)
          .expect(200)
      ).body.interested,
    ).toBe(1);
    expect(
      (
        await a.client
          .put(`${API}/posts/${event.body.id}/attendance`, { status: 'NONE' }, a.token)
          .expect(200)
      ).body.going,
    ).toBe(0);

    // Bloqueo: el bloqueado no ve ni interactúa.
    await barber.client.put(`${API}/users/${a.userId}/block`, {}, barber.token).expect(200);
    const blocked = await a.client
      .put(`${API}/posts/${event.body.id}/like`, {}, a.token)
      .expect(403);
    expect(blocked.body.code).toBe('BLOCKED');
    const feedA = await a.client.get(`${API}/feed`, a.token).expect(200);
    expect(feedA.body.items.map((p: { id: string }) => p.id)).not.toContain(event.body.id);
    expect(
      (await barber.client.get(`${API}/me/blocks`, barber.token).expect(200)).body,
    ).toHaveLength(1);
    await barber.client.delete(`${API}/users/${a.userId}/block`, barber.token).expect(200);

    // Filtro de palabras.
    await prisma.appSetting.upsert({
      where: { key: 'community.blocked_words' },
      create: { key: 'community.blocked_words', value: 'groseria, otra mala' },
      update: { value: 'groseria, otra mala' },
    });
    clock.current += 120_000; // el filtro se relee cada minuto
    const bad = await b.client
      .post(`${API}/posts/${event.body.id}/comments`, { body: 'Eres una GROSERÍA' }, b.token)
      .expect(400);
    expect(bad.body.code).toBe('CONTENT_NOT_ALLOWED');

    // Reportes: con 3 personas distintas se oculta; soporte la revisa y la restaura.
    const reporters = [a, b, await kit.verified()];
    for (const r of reporters) {
      await r.client
        .post(
          `${API}/reports`,
          { targetType: 'post', targetId: event.body.id, reason: 'SPAM' },
          r.token,
        )
        .expect(202);
    }
    await a.client
      .post(
        `${API}/reports`,
        { targetType: 'post', targetId: event.body.id, reason: 'SPAM' },
        a.token,
      )
      .expect(202);
    const gone = await b.client.get(`${API}/posts/${event.body.id}`, b.token).expect(410);
    expect(gone.body.code).toBe('POST_HIDDEN');
    const reports = await boss.client.get(`${API}/admin/community/reports`, boss.token).expect(200);
    const mineReport = reports.body.find((r: { targetId: string }) => r.targetId === event.body.id);
    expect(mineReport).toMatchObject({ openReports: 3, targetState: 'HIDDEN' });
    await a.client.get(`${API}/admin/community/reports`, a.token).expect(403);
    const dismissed = await boss.client
      .post(
        `${API}/admin/community/reports/${mineReport.id}/resolve`,
        { action: 'DISMISS', reason: 'No es spam' },
        boss.token,
      )
      .expect(200);
    expect(dismissed.body).toMatchObject({ status: 'DISMISSED', targetState: 'VISIBLE' });
    await b.client.get(`${API}/posts/${event.body.id}`, b.token).expect(200);

    // Me gusta en valoraciones.
    const shop = await kit.shopReady();
    const visit = await kit.attended(shop, lima(MONDAY, '10:00'));
    const review = await visit.person.client
      .post(
        `${API}/bookings/${visit.id}/review`,
        { rating: 5, comment: 'Excelente' },
        visit.person.token,
      )
      .expect(201);
    const like = await a.client
      .put(`${API}/reviews/${review.body.id}/like`, {}, a.token)
      .expect(200);
    expect(like.body).toEqual({ liked: true, likes: 1 });
    const publicReviews = await a.client
      .get(`${API}/barbershops/${shop.shopId}/reviews`, a.token)
      .expect(200);
    expect(publicReviews.body.items[0]).toMatchObject({ likes: 1, likedByMe: true });
    expect(publicReviews.body.items[0]).toHaveProperty('authorPhotoUrl');
  });
});
