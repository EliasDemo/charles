import type { OutboxMessage } from '../../common/outbox/outbox.service';
import type { PlannedNotification } from './notification-catalog';
import { NotificationsService } from './notifications.service';

const NOW = Date.parse('2030-01-07T15:00:00Z');

/** Eventos de negocio → avisos (sin base: la consulta se simula). */
describe('NotificationsService: eventos de ofertas, planes, membresías y revisión', () => {
  function build(prisma: Record<string, unknown>) {
    const service = new NotificationsService(
      {
        barbershopMember: { findMany: jest.fn().mockResolvedValue([{ userId: 'o-1' }]) },
        ...prisma,
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { register: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      { now: () => NOW },
    );
    return (type: string, payload: Record<string, unknown>) =>
      (service as unknown as { plan: (m: OutboxMessage) => Promise<PlannedNotification[]> }).plan({
        id: 'evt',
        type,
        payload,
      } as unknown as OutboxMessage);
  }

  const offer = (status: string) => ({
    jobOffer: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'of-1',
        title: 'Puesto fijo',
        status,
        barbershop: { name: 'Centro', members: [{ userId: 'o-1' }, { userId: 'm-1' }] },
        barberProfile: { userId: 'b-1', displayName: 'Rocío' },
      }),
    },
  });

  it('oferta creada: al barbero; respondida: a la barbería (aceptada o rechazada)', async () => {
    const created = await build(offer('PENDING'))('job.offer_created', { offerId: 'of-1' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userId: 'b-1', type: 'JOB_OFFER_RECEIVED' });
    const accepted = await build(offer('ACCEPTED'))('job.offer_answered', { offerId: 'of-1' });
    expect(accepted.map((p) => p.userId)).toEqual(['o-1', 'm-1']);
    expect(accepted[0]!.detail.title).toBe('Oferta aceptada');
    const rejected = await build(offer('REJECTED'))('job.offer_answered', { offerId: 'of-1' });
    expect(rejected[0]!.detail.title).toBe('Oferta rechazada');
    const missing = await build({ jobOffer: { findUnique: jest.fn().mockResolvedValue(null) } })(
      'job.offer_created',
      {},
    );
    expect(missing).toEqual([]);
  });

  it('plan y membresía: con datos y cuando ya no existen', async () => {
    const sub = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: 's-1',
          checkoutUrl: null,
          trialEndsAt: null,
          graceUntil: null,
          currentPeriodEnd: new Date(NOW + 86_400_000),
          nextPriceAmount: null,
          nextPriceFrom: null,
          currency: 'PEN',
          plan: { name: 'Pro' },
          barbershop: { name: 'Centro', timezone: 'America/Lima', members: [{ userId: 'o-1' }] },
        }),
      },
    };
    expect(
      await build(sub)('billing.subscription', { subscriptionId: 's-1', notice: 'activated' }),
    ).toHaveLength(1);
    expect(
      await build({ subscription: { findUnique: jest.fn().mockResolvedValue(null) } })(
        'billing.subscription',
        {},
      ),
    ).toEqual([]);
    const membership = {
      membership: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'm-1',
          userId: 'c-1',
          checkoutUrl: null,
          currentPeriodEnd: new Date(NOW + 86_400_000),
          membershipPlan: { name: 'Corte mensual' },
          barbershop: { name: 'Centro', timezone: 'America/Lima' },
          lots: [{ remaining: 2 }, { remaining: 1 }],
        }),
      },
    };
    const plans = await build(membership)('billing.membership', {
      membershipId: 'm-1',
      notice: 'credits_granted',
    });
    expect(plans[0]).toMatchObject({ userId: 'c-1' });
    expect(
      await build({ membership: { findUnique: jest.fn().mockResolvedValue(null) } })(
        'billing.membership',
        {},
      ),
    ).toEqual([]);
  });

  it('revisión de la barbería: aprobada o con cambios; sin barbería, nada', async () => {
    const shop = {
      barbershop: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'sh-1', name: 'Centro', reviewNotes: 'Falta foto' }),
      },
    };
    expect(await build(shop)('barbershop.review_approved', { barbershopId: 'sh-1' })).not.toEqual(
      [],
    );
    expect(
      await build(shop)('barbershop.review_changes_requested', { barbershopId: 'sh-1' }),
    ).not.toEqual([]);
    expect(await build(shop)('barbershop.review_approved', {})).toEqual([]);
    expect(await build({})('user.disabled', {})).toEqual([]);
  });

  it('lista de espera: aviso urgente con el servicio y la hora; sin inscripción, nada', async () => {
    const entry = {
      waitlistEntry: {
        findUnique: jest.fn().mockResolvedValue({
          userId: 'c-1',
          barbershopId: 'sh-1',
          barbershop: { name: 'Centro', timezone: 'America/Lima' },
          service: { name: 'Corte' },
        }),
      },
    };
    const plans = await build(entry)('waitlist.slot_freed', {
      entryId: 'w-1',
      startAt: '2030-01-07T15:00:00.000Z',
    });
    expect(plans[0]).toMatchObject({
      userId: 'c-1',
      type: 'WAITLIST_SLOT_FREED',
      urgent: true,
      resource: { type: 'barbershop', id: 'sh-1' },
    });
    expect(plans[0]!.detail.body).toContain('Corte en Centro');
    expect(plans[0]!.detail.body).toContain('10:00');
    expect(await build(entry)('waitlist.slot_freed', { entryId: 'w-1' })).toEqual([]);
    expect(
      await build({ waitlistEntry: { findUnique: jest.fn().mockResolvedValue(null) } })(
        'waitlist.slot_freed',
        { entryId: 'w-1', startAt: '2030-01-07T15:00:00.000Z' },
      ),
    ).toEqual([]);
  });

  describe('Comunidad', () => {
    const blocks = (rows: { blockerId: string; blockedId: string }[] = []) => ({
      userBlock: { findMany: jest.fn().mockResolvedValue(rows) },
    });
    const shopPost = {
      id: 'p-1',
      type: 'EVENT',
      createdById: 'o-1',
      barbershopId: 'sh-1',
      authorProfileId: null,
      deletedAt: null,
      removedAt: null,
      likeCount: 5,
      barbershop: { name: 'Centro' },
      authorProfile: null,
    };

    it('publicación nueva: a los seguidores, sin el autor ni bloqueados; retirada, nada', async () => {
      const prisma = {
        post: { findUnique: jest.fn().mockResolvedValue(shopPost) },
        follow: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { followerId: 'f-1' },
              { followerId: 'f-2' },
              { followerId: 'o-1' },
            ]),
        },
        ...blocks([{ blockerId: 'f-2', blockedId: 'o-1' }]),
      };
      const plans = await build(prisma)('community.post_created', { postId: 'p-1' });
      expect(plans.map((p) => p.userId)).toEqual(['f-1']);
      expect(plans[0]).toMatchObject({
        type: 'COMMUNITY_NEW_POST',
        resource: { type: 'post', id: 'p-1' },
      });
      expect(plans[0]!.detail.body).toBe('Centro publicó un evento.');
      const profilePost = {
        ...shopPost,
        type: 'OTRO',
        barbershopId: null,
        authorProfileId: 'pr-1',
        barbershop: null,
        authorProfile: { displayName: 'Rocío' },
      };
      const byProfile = await build({
        ...prisma,
        post: { findUnique: jest.fn().mockResolvedValue(profilePost) },
      })('community.post_created', { postId: 'p-1' });
      expect(byProfile[0]!.detail.body).toBe('Rocío publicó algo nuevo.');
      const gone = await build({
        ...prisma,
        post: { findUnique: jest.fn().mockResolvedValue({ ...shopPost, removedAt: new Date() }) },
      })('community.post_created', { postId: 'p-1' });
      expect(gone).toEqual([]);
      expect(
        await build({ post: { findUnique: jest.fn().mockResolvedValue(null) } })(
          'community.post_created',
          {},
        ),
      ).toEqual([]);
    });

    it('comentario: mención, respuesta y aviso al autor, sin duplicar ni avisar a bloqueados', async () => {
      const comment = {
        authorId: 'c-1',
        body: 'Muy bueno '.repeat(12),
        mentionUserId: 'm-1',
        author: { username: 'ana' },
        parent: { authorId: 'r-1' },
        post: { id: 'p-1', createdById: 'o-1', barbershopId: 'sh-1', authorProfileId: null },
      };
      const prisma = {
        postComment: { findUnique: jest.fn().mockResolvedValue(comment) },
        ...blocks(),
      };
      const plans = await build(prisma)('community.commented', { commentId: 'k-1' });
      expect(plans.map((p) => [p.userId, p.type])).toEqual([
        ['m-1', 'COMMUNITY_MENTION'],
        ['r-1', 'COMMUNITY_REPLY'],
        ['o-1', 'COMMUNITY_COMMENT'],
      ]);
      expect(plans[0]!.detail.body).toContain('…');
      // La persona mencionada también es el autor del comentario principal: un solo aviso.
      const same = await build({
        postComment: {
          findUnique: jest.fn().mockResolvedValue({
            ...comment,
            mentionUserId: 'o-1',
            parent: null,
            body: 'Hola',
            post: { ...comment.post, barbershopId: null },
          }),
        },
        ...blocks([{ blockerId: 'c-1', blockedId: 'x-9' }]),
      })('community.commented', { commentId: 'k-1' });
      expect(same.map((p) => p.type)).toEqual(['COMMUNITY_MENTION']);
      expect(
        await build({ postComment: { findUnique: jest.fn().mockResolvedValue(null) } })(
          'community.commented',
          {},
        ),
      ).toEqual([]);
    });

    it('me gusta agrupados por hora, en publicaciones y comentarios', async () => {
      const prisma = {
        post: { findUnique: jest.fn().mockResolvedValue(shopPost) },
        postComment: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ authorId: 'c-1', likeCount: 1, post: { id: 'p-1' } }),
        },
        user: { findUnique: jest.fn().mockResolvedValue({ username: 'luis' }) },
        ...blocks(),
      };
      const onPost = await build(prisma)('community.liked', { postId: 'p-1', userId: 'l-1' });
      expect(onPost[0]).toMatchObject({
        userId: 'o-1',
        type: 'COMMUNITY_LIKE',
        dedupeKey: expect.stringMatching(/^like:p-1:/),
      });
      expect(onPost[0]!.detail.body).toBe('A @luis y 4 personas más les gusta tu publicación.');
      const onComment = await build(prisma)('community.liked', { commentId: 'k-1', userId: 'l-1' });
      expect(onComment[0]).toMatchObject({ userId: 'c-1' });
      expect(onComment[0]!.detail.body).toBe('A @luis le gusta tu comentario.');
      const two = await build({
        ...prisma,
        post: { findUnique: jest.fn().mockResolvedValue({ ...shopPost, likeCount: 2 }) },
      })('community.liked', { postId: 'p-1', userId: 'l-1' });
      expect(two[0]!.detail.body).toContain('1 persona más');
      expect(
        await build({ ...prisma, user: { findUnique: jest.fn().mockResolvedValue(null) } })(
          'community.liked',
          { postId: 'p-1', userId: 'l-1' },
        ),
      ).toEqual([]);
      expect(await build(prisma)('community.liked', { postId: 'p-1' })).toEqual([]);
      const own = await build(prisma)('community.liked', { postId: 'p-1', userId: 'o-1' });
      expect(own).toEqual([]);
    });
  });
});
