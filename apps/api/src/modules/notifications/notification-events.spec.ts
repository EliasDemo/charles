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
});
