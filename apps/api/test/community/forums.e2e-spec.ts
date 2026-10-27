import type { NestExpressApplication } from '@nestjs/platform-express';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { staffToken } from '../support/mfa';

/** Foros: temas, hilos, respuestas, "me sirvió", mejor respuesta, bloqueos y moderación. */
describe('Foros (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  let boss: Person;
  let categoryId: string;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };
  const anon = () => new AuthClient(app);
  const slug = `tecnicas-${Date.now().toString(36)}`;

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
  afterAll(() => app.close());

  async function deliver(): Promise<void> {
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
    await app.get(NotificationsService).deliverDue();
  }

  function newThread(who: Person, title: string, body = 'Detalle de la pregunta.') {
    return who.client.post(`${API}/forums/threads`, { categoryId, title, body }, who.token);
  }

  it('ADMIN crea y ordena temas; el público solo ve los activos', async () => {
    const created = await boss.client
      .post(
        `${API}/admin/forum/categories`,
        { slug, name: 'Técnicas de corte', description: 'Fades, tijera y navaja', sortOrder: 1 },
        boss.token,
      )
      .expect(201);
    categoryId = created.body.id as string;
    expect(created.body).toMatchObject({ slug, threadCount: 0, isActive: true });
    await boss.client
      .post(`${API}/admin/forum/categories`, { slug, name: 'Repetido' }, boss.token)
      .expect(409);
    await boss.client
      .post(`${API}/admin/forum/categories`, { slug: 'Con Mayúsculas', name: 'X' }, boss.token)
      .expect(400);
    const hidden = await boss.client
      .post(
        `${API}/admin/forum/categories`,
        { slug: `${slug}-off`, name: 'Tema apagado' },
        boss.token,
      )
      .expect(201);
    await boss.client
      .patch(`${API}/admin/forum/categories/${hidden.body.id}`, { isActive: false }, boss.token)
      .expect(200);

    const list = (await anon().get(`${API}/forums/categories`).expect(200)).body;
    const ids = list.map((c: { id: string }) => c.id);
    expect(ids).toContain(categoryId);
    expect(ids).not.toContain(hidden.body.id);
    const user = await kit.verified();
    await user.client.get(`${API}/admin/forum/categories`, user.token).expect(403);
    await user.client
      .post(
        `${API}/forums/threads`,
        { categoryId: hidden.body.id, title: 'Pregunta en tema apagado', body: 'x' },
        user.token,
      )
      .expect(400);
  });

  it('preguntar, responder, "me sirvió" y mejor respuesta, con avisos', async () => {
    const asker = await kit.verified();
    const helper = await kit.verified();
    const other = await kit.verified();
    await asker.client
      .post(`${API}/forums/threads`, { categoryId, title: 'Corta', body: 'x' }, asker.token)
      .expect(400);
    await anon()
      .post(`${API}/forums/threads`, { categoryId, title: 'Sin sesión no se puede', body: 'x' })
      .expect(401);

    const thread = await newThread(asker, '¿Cómo hago un degradado sin escalones?').expect(201);
    expect(thread.body).toMatchObject({
      replyCount: 0,
      solved: false,
      isMine: true,
      categoryName: 'Técnicas de corte',
      author: { userId: asker.userId, isBarber: false },
    });
    const threadId = thread.body.id as string;

    const unanswered = (
      await anon().get(`${API}/forums/threads?categoryId=${categoryId}&sort=unanswered`).expect(200)
    ).body.items.map((t: { id: string }) => t.id);
    expect(unanswered).toContain(threadId);
    const found = await anon().get(`${API}/forums/threads?q=degradado sin`).expect(200);
    expect(found.body.items.map((t: { id: string }) => t.id)).toContain(threadId);

    const first = await helper.client
      .post(
        `${API}/forums/threads/${threadId}/replies`,
        { body: 'Usa el peine en ángulo y sube de a poco.' },
        helper.token,
      )
      .expect(201);
    clock.current += 60_000;
    const second = await other.client
      .post(
        `${API}/forums/threads/${threadId}/replies`,
        { body: 'Prueba con la 1.5.' },
        other.token,
      )
      .expect(201);
    await deliver();
    expect(
      await prisma.notification.count({
        where: { userId: asker.userId, type: 'FORUM_REPLY', channel: 'IN_APP' },
      }),
    ).toBe(2);

    // "Me sirvió": idempotente, no en respuestas propias.
    await helper.client
      .put(`${API}/forums/replies/${first.body.id}/helpful`, {}, helper.token)
      .expect(403);
    for (let i = 0; i < 2; i++) {
      const voted = await asker.client
        .put(`${API}/forums/replies/${first.body.id}/helpful`, {}, asker.token)
        .expect(200);
      expect(voted.body).toMatchObject({ helpful: 1, votedHelpful: true });
    }
    const byHelpful = await anon()
      .get(`${API}/forums/threads/${threadId}/replies?sort=helpful`)
      .expect(200);
    expect(byHelpful.body.items[0].id).toBe(first.body.id);

    // Solo el autor marca la mejor respuesta; va primero y avisa a quien la escribió.
    await helper.client
      .put(`${API}/forums/threads/${threadId}/solution`, { replyId: second.body.id }, helper.token)
      .expect(404);
    const solved = await asker.client
      .put(`${API}/forums/threads/${threadId}/solution`, { replyId: second.body.id }, asker.token)
      .expect(200);
    expect(solved.body).toMatchObject({ solved: true, solutionReplyId: second.body.id });
    const replies = await anon().get(`${API}/forums/threads/${threadId}/replies`).expect(200);
    expect(replies.body.items.map((r: { id: string }) => r.id)).toEqual([
      second.body.id,
      first.body.id,
    ]);
    expect(replies.body.items[0].isSolution).toBe(true);
    await deliver();
    expect(
      await prisma.notification.count({ where: { userId: other.userId, type: 'FORUM_SOLUTION' } }),
    ).toBeGreaterThan(0);

    // Si la mejor respuesta se borra, el hilo deja de estar resuelto.
    await other.client.delete(`${API}/forums/replies/${second.body.id}`, other.token).expect(204);
    const after = await anon().get(`${API}/forums/threads/${threadId}`).expect(200);
    expect(after.body).toMatchObject({ solved: false, replyCount: 1 });

    // Editar y borrar el propio hilo.
    const edited = await asker.client
      .patch(`${API}/forums/threads/${threadId}`, { body: 'Ya lo resolví, gracias.' }, asker.token)
      .expect(200);
    expect(edited.body.editedAt).not.toBeNull();
    await helper.client.delete(`${API}/forums/threads/${threadId}`, helper.token).expect(404);
    const before = await prisma.forumCategory.findUniqueOrThrow({ where: { id: categoryId } });
    await asker.client.delete(`${API}/forums/threads/${threadId}`, asker.token).expect(204);
    await anon().get(`${API}/forums/threads/${threadId}`).expect(404);
    expect(
      (await prisma.forumCategory.findUniqueOrThrow({ where: { id: categoryId } })).threadCount,
    ).toBe(before.threadCount - 1);
  });

  it('bloqueos: no se ven hilos ni respuestas de cuentas bloqueadas, ni se les responde', async () => {
    const a = await kit.verified();
    const b = await kit.verified();
    const thread = await newThread(a, 'Recomiendan alguna máquina inalámbrica').expect(201);
    await b.client.put(`${API}/users/${a.userId}/block`, {}, b.token).expect(200);
    const list = await b.client.get(`${API}/forums/threads?categoryId=${categoryId}`, b.token);
    expect(list.body.items.map((t: { id: string }) => t.id)).not.toContain(thread.body.id);
    await b.client.get(`${API}/forums/threads/${thread.body.id}`, b.token).expect(404);
    await b.client
      .post(`${API}/forums/threads/${thread.body.id}/replies`, { body: 'Hola' }, b.token)
      .expect(404);
  });

  it('moderación: reportes ocultan; soporte retira, restaura, fija y cierra', async () => {
    const author = await kit.verified();
    const thread = await newThread(author, 'Vendo cursos baratos aquí, escríbeme').expect(201);
    const threadId = thread.body.id as string;
    const count = async () =>
      (await prisma.forumCategory.findUniqueOrThrow({ where: { id: categoryId } })).threadCount;
    const start = await count();

    for (let i = 0; i < 3; i++) {
      const r = await kit.verified();
      await r.client
        .post(
          `${API}/reports`,
          { targetType: 'forum_thread', targetId: threadId, reason: 'SPAM' },
          r.token,
        )
        .expect(202);
    }
    const gone = await anon().get(`${API}/forums/threads/${threadId}`).expect(410);
    expect(gone.body.code).toBe('THREAD_HIDDEN');
    // Su autor todavía lo ve (está en revisión).
    await author.client.get(`${API}/forums/threads/${threadId}`, author.token).expect(200);

    const reports = await boss.client
      .get(`${API}/admin/community/reports?targetType=FORUM_THREAD`, boss.token)
      .expect(200);
    const report = reports.body.find((r: { targetId: string }) => r.targetId === threadId);
    expect(report).toMatchObject({ openReports: 3, targetState: 'HIDDEN' });
    expect(report.preview).toContain('Vendo cursos');
    await boss.client
      .post(
        `${API}/admin/community/reports/${report.id}/resolve`,
        { action: 'REMOVE', reason: 'Spam' },
        boss.token,
      )
      .expect(200);
    expect(await count()).toBe(start - 1);
    const listed = await boss.client
      .get(`${API}/admin/forum/threads?state=REMOVED`, boss.token)
      .expect(200);
    expect(listed.body.find((t: { id: string }) => t.id === threadId)).toMatchObject({
      state: 'REMOVED',
    });

    // Restaurar, fijar y cerrar desde el panel.
    const moderated = await boss.client
      .patch(
        `${API}/admin/forum/threads/${threadId}`,
        { removed: false, pinned: true, locked: true },
        boss.token,
      )
      .expect(200);
    expect(moderated.body).toMatchObject({ state: 'VISIBLE', pinned: true, locked: true });
    expect(await count()).toBe(start);
    const top = await anon().get(`${API}/forums/threads?categoryId=${categoryId}`).expect(200);
    expect(top.body.items[0].id).toBe(threadId);
    const replier = await kit.verified();
    const locked = await replier.client
      .post(`${API}/forums/threads/${threadId}/replies`, { body: '¿Precio?' }, replier.token)
      .expect(409);
    expect(locked.body.code).toBe('THREAD_LOCKED');

    // Reporte de una respuesta retirada: deja de contar en el hilo.
    await boss.client
      .patch(`${API}/admin/forum/threads/${threadId}`, { locked: false }, boss.token)
      .expect(200);
    const reply = await replier.client
      .post(
        `${API}/forums/threads/${threadId}/replies`,
        { body: 'Contenido ofensivo' },
        replier.token,
      )
      .expect(201);
    const reporter = await kit.verified();
    await reporter.client
      .post(
        `${API}/reports`,
        { targetType: 'forum_reply', targetId: reply.body.id, reason: 'OFFENSIVE' },
        reporter.token,
      )
      .expect(202);
    const replyReports = await boss.client
      .get(`${API}/admin/community/reports?targetType=FORUM_REPLY`, boss.token)
      .expect(200);
    const rr = replyReports.body.find((r: { targetId: string }) => r.targetId === reply.body.id);
    expect(rr.preview).toContain('Respuesta en «Vendo cursos');
    await boss.client
      .post(
        `${API}/admin/community/reports/${rr.id}/resolve`,
        { action: 'REMOVE', reason: 'Ofensivo' },
        boss.token,
      )
      .expect(200);
    expect(
      (await anon().get(`${API}/forums/threads/${threadId}`).expect(200)).body.replyCount,
    ).toBe(0);
  });
});
