import type { AppConfig } from '../../common/config/env.validation';
import {
  type BookingContext,
  formatMoney,
  planAccountDisabled,
  planBarbershopSuspended,
  planBookingEvent,
  planNewReview,
  type PlannedNotification,
  planRefund,
  planReminder,
  planSupportReply,
} from './notification-catalog';
import { DEVICE_NOT_REGISTERED, ExpoPushSender } from './push-sender';

/** Simula `fetch` (sin red). */
const fakeFetch = (handler: (url: string, init: RequestInit) => Response): typeof fetch =>
  ((url: string, init: RequestInit) => Promise.resolve(handler(url, init))) as typeof fetch;

const startAt = Date.UTC(2030, 0, 9, 17); // miércoles 12:00 en Lima
const ctx: BookingContext = {
  bookingId: 'b1',
  clientId: 'client',
  barberUserId: 'barber',
  staffIds: ['owner', 'manager'],
  barbershopName: 'Barbería Sol',
  timezone: 'America/Lima',
  startAt,
  serviceName: 'Corte clásico',
  refund: { amount: 2500, currency: 'PEN' },
};
const farNow = startAt - 3 * 24 * 3_600_000;
const byUser = (plans: PlannedNotification[]) =>
  Object.fromEntries(plans.map((p) => [p.userId, [p.type, [...p.channels].sort(), p.mandatory]]));

describe('RF-NOT-002 catálogo de avisos', () => {
  it('confirmada: cliente y barbero por los tres canales; responsables push y bandeja', () => {
    expect(
      byUser(
        planBookingEvent(
          { status: 'CONFIRMED', from: 'PENDING_PAYMENT', actorRole: 'SYSTEM' },
          ctx,
          farNow,
        ),
      ),
    ).toEqual({
      client: ['BOOKING_CONFIRMED', ['EMAIL', 'IN_APP', 'PUSH'], false],
      barber: ['NEW_BOOKING', ['EMAIL', 'IN_APP', 'PUSH'], false],
      owner: ['NEW_BOOKING', ['IN_APP', 'PUSH'], false],
      manager: ['NEW_BOOKING', ['IN_APP', 'PUSH'], false],
    });
  });

  it('una persona con dos papeles recibe un solo aviso', () => {
    const plans = planBookingEvent(
      { status: 'CONFIRMED', from: 'PENDING_PAYMENT', actorRole: 'SYSTEM' },
      { ...ctx, barberUserId: 'owner' },
      farNow,
    );
    expect(plans.filter((p) => p.userId === 'owner')).toHaveLength(1);
  });

  it('cancelaciones según quién cancela', () => {
    const cancel = (actorRole: string, from = 'CONFIRMED') =>
      byUser(planBookingEvent({ status: 'CANCELLED', from, actorRole }, ctx, farNow));
    expect(cancel('CLIENT')).toMatchObject({
      client: ['BOOKING_CANCELLED', ['EMAIL', 'IN_APP', 'PUSH'], false],
      owner: ['BOOKING_CANCELLED_BY_CLIENT', ['IN_APP', 'PUSH'], false],
    });
    expect(cancel('BARBERSHOP')).toEqual({
      client: ['BOOKING_CANCELLED_BY_BARBERSHOP', ['EMAIL', 'IN_APP', 'PUSH'], true],
      barber: ['BOOKING_CANCELLED', ['IN_APP', 'PUSH'], false],
    });
    expect(cancel('SUPPORT')).toEqual({
      client: ['BOOKING_CANCELLED_BY_SUPPORT', ['EMAIL', 'IN_APP', 'PUSH'], true],
      barber: ['BOOKING_CANCELLED', ['IN_APP'], false],
    });
    expect(cancel('SYSTEM', 'PENDING_PAYMENT')).toEqual({
      client: ['PAYMENT_REJECTED', ['IN_APP', 'PUSH'], true],
    });
    expect(cancel('CLIENT', 'PENDING_PAYMENT')).toEqual({});
  });

  it('urgente si la cita es dentro de 24 h', () => {
    const [soon] = planBookingEvent(
      { status: 'CANCELLED', from: 'CONFIRMED', actorRole: 'BARBERSHOP' },
      ctx,
      startAt - 3_600_000,
    );
    const [far] = planBookingEvent(
      { status: 'CANCELLED', from: 'CONFIRMED', actorRole: 'BARBERSHOP' },
      ctx,
      farNow,
    );
    expect([soon!.urgent, far!.urgent]).toEqual([true, false]);
  });

  it('ningún push lleva montos, nombres, servicio ni motivos; todos llevan recurso', () => {
    const all: PlannedNotification[] = [
      ...planBookingEvent(
        { status: 'CONFIRMED', from: 'PENDING_PAYMENT', actorRole: 'SYSTEM' },
        ctx,
        farNow,
      ),
      ...['CLIENT', 'BARBERSHOP', 'SUPPORT'].flatMap((actorRole) =>
        planBookingEvent({ status: 'CANCELLED', from: 'CONFIRMED', actorRole }, ctx, farNow),
      ),
      ...planBookingEvent(
        { status: 'CANCELLED', from: 'PENDING_PAYMENT', actorRole: 'SYSTEM' },
        ctx,
        farNow,
      ),
      ...planBookingEvent(
        { status: 'EXPIRED', from: 'PENDING_PAYMENT', actorRole: 'SYSTEM' },
        ctx,
        farNow,
      ),
      ...planBookingEvent(
        { status: 'NO_SHOW', from: 'CONFIRMED', actorRole: 'BARBERSHOP' },
        ctx,
        farNow,
      ),
      planReminder(ctx, 24),
      planRefund({
        outcome: 'SUCCEEDED',
        clientId: 'c',
        bookingId: 'b1',
        amount: 2500,
        currency: 'PEN',
      }),
      planRefund({
        outcome: 'FAILED',
        clientId: 'c',
        bookingId: 'b1',
        amount: 2500,
        currency: 'PEN',
      }),
      ...planNewReview({ staffIds: ['o'], reviewId: 'r1', rating: 2 }),
      planSupportReply({ userId: 'u', ticketId: 't1', subject: 'Mi cobro de S/ 25' }),
      planAccountDisabled('u'),
      ...planBarbershopSuspended({
        staffIds: ['o'],
        barbershopId: 's1',
        barbershopName: 'Barbería Sol',
      }),
    ];
    expect(all.length).toBeGreaterThan(15);
    for (const plan of all) {
      const pushText = `${plan.push.title} ${plan.push.body}`;
      expect([plan.type, pushText]).toEqual([
        plan.type,
        expect.not.stringMatching(/S\/|\d+[.,]\d{2}|Barbería Sol|Corte|enfermo|cobro/),
      ]);
      expect(plan.resource.type).toBeTruthy();
    }
  });

  it('la bandeja y el correo sí dan el detalle y el monto', () => {
    const [client] = planBookingEvent(
      { status: 'CANCELLED', from: 'CONFIRMED', actorRole: 'BARBERSHOP' },
      ctx,
      farNow,
    );
    expect(client!.detail.body).toBe(
      'Corte clásico en Barbería Sol, miércoles 9 de enero a las 12:00. Te devolveremos S/ 25.00.',
    );
    expect(client!.email!.text).toContain('S/ 25.00');
    const [noRefund] = planBookingEvent(
      { status: 'CANCELLED', from: 'CONFIRMED', actorRole: 'BARBERSHOP' },
      { ...ctx, refund: null },
      farNow,
    );
    expect(noRefund!.detail.body).toContain('No había pagos que devolver.');
    expect(formatMoney(1234, 'USD')).toBe('USD 12.34');
    expect(planReminder(ctx, 2).detail.title).toBe('Tu cita es pronto');
    expect(planNewReview({ staffIds: ['o'], reviewId: 'r', rating: 1 })[0]!.detail.body).toContain(
      '1 estrella.',
    );
  });
});

describe('ExpoPushSender (HTTP simulado)', () => {
  const config = { push: { driver: 'expo', expoAccessToken: 'secreto' } } as unknown as AppConfig;

  it('envía por lotes con el token de acceso y traduce los tickets', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const http = fakeFetch((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = JSON.parse(init.body as string) as unknown[];
      return new Response(
        JSON.stringify({
          data: body.map((_, i) =>
            i === 1
              ? { status: 'error', details: { error: DEVICE_NOT_REGISTERED } }
              : i === 2
                ? { status: 'error', details: { error: 'MessageRateExceeded' } }
                : { status: 'ok', id: `t${i}` },
          ),
        }),
        { status: 200 },
      );
    });
    const sender = new ExpoPushSender(config, http);
    const messages = Array.from({ length: 3 }, (_, i) => ({
      to: `tok${i}`,
      title: 'x',
      body: 'y',
      data: {},
    }));
    expect(await sender.send(messages)).toEqual([
      { ok: true, ticketId: 't0' },
      { ok: false, error: DEVICE_NOT_REGISTERED, permanent: true },
      { ok: false, error: 'MessageRateExceeded', permanent: false },
    ]);
    expect(calls[0]!.url).toBe('https://exp.host/--/api/v2/push/send');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer secreto');
  });

  it('si Expo responde con error HTTP, lanza (se reintenta); recibos', async () => {
    const failing = new ExpoPushSender(
      config,
      fakeFetch(() => new Response('', { status: 503 })),
    );
    await expect(failing.send([{ to: 't', title: 'x', body: 'y', data: {} }])).rejects.toThrow(
      /503/,
    );
    const receiptsBody = {
      data: {
        a: { status: 'ok' },
        b: { status: 'error', details: { error: DEVICE_NOT_REGISTERED } },
      },
    };
    const receipts = new ExpoPushSender(
      config,
      fakeFetch(() => new Response(JSON.stringify(receiptsBody))),
    );
    expect(await receipts.receipts(['a', 'b'])).toEqual(
      new Map([
        ['a', { ok: true }],
        ['b', { ok: false, error: DEVICE_NOT_REGISTERED }],
      ]),
    );
  });
});
