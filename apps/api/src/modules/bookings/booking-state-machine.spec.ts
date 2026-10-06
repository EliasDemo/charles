import { AppException } from '../../common/errors/app.exception';
import type { OutboxService } from '../../common/outbox/outbox.service';
import type { Prisma } from '../../generated/prisma/client';
import { BookingStatus } from '../../generated/prisma/enums';
import {
  BOOKING_TRANSITIONS,
  BookingStateMachine,
  bookingEventType,
  canTransition,
  SYSTEM_ACTOR,
} from './booking-state-machine';

const ALL = Object.values(BookingStatus);
const ALLOWED: [BookingStatus, BookingStatus][] = [
  ['PENDING_PAYMENT', 'CONFIRMED'],
  ['PENDING_PAYMENT', 'EXPIRED'],
  ['PENDING_PAYMENT', 'CANCELLED'],
  ['CONFIRMED', 'ATTENDED'],
  ['CONFIRMED', 'CANCELLED'],
  ['CONFIRMED', 'NO_SHOW'],
];

describe('BookingStateMachine (RF-RES-006, CLAUDE.md §8)', () => {
  describe('tabla de transiciones', () => {
    it.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
      const expected = ALLOWED.some(([f, t]) => f === from && t === to);
      expect(canTransition(from, to)).toBe(expected);
    });

    it('los estados finales no tienen salida', () => {
      for (const final of ['ATTENDED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'] as const) {
        expect(BOOKING_TRANSITIONS[final]).toEqual([]);
      }
    });

    it('tipo de evento por estado de destino', () => {
      expect(bookingEventType('NO_SHOW')).toBe('booking.no_show');
      expect(bookingEventType('CONFIRMED')).toBe('booking.confirmed');
    });
  });

  describe('transition', () => {
    const START = Date.parse('2030-01-07T15:00:00Z');

    function build(row: { status: BookingStatus } | null, now = START - 3600_000) {
      const writes: { kind: string; data: unknown }[] = [];
      const tx = {
        $queryRaw: () =>
          Promise.resolve(
            row
              ? [
                  {
                    status: row.status,
                    start_at: new Date(START),
                    barbershop_id: 'shop',
                    client_id: 'client',
                    barber_id: 'barber',
                    metadata: { request: { a: 1 } },
                  },
                ]
              : [],
          ),
        booking: {
          update: (args: unknown) => {
            writes.push({ kind: 'booking', data: args });
            return Promise.resolve();
          },
        },
        bookingStatusHistory: {
          create: (args: unknown) => {
            writes.push({ kind: 'history', data: args });
            return Promise.resolve();
          },
        },
      } as unknown as Prisma.TransactionClient;
      const outbox = {
        publish: (_tx: unknown, type: string, payload: unknown) => {
          writes.push({ kind: 'outbox', data: { type, payload } });
          return Promise.resolve('event-id');
        },
      } as unknown as OutboxService;
      return { machine: new BookingStateMachine(outbox, { now: () => now }), tx, writes };
    }

    const codeOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        return error instanceof AppException ? error.code : 'other';
      }
      return 'ok';
    };

    it('actualiza, escribe el historial y publica el evento (en la transacción recibida)', async () => {
      const { machine, tx, writes } = build({ status: 'PENDING_PAYMENT' });
      expect(await machine.transition(tx, 'b1', 'CONFIRMED', SYSTEM_ACTOR)).toBe('PENDING_PAYMENT');
      expect(writes.map((w) => w.kind)).toEqual(['booking', 'history', 'outbox']);
      expect(writes[1]!.data).toEqual({
        data: {
          bookingId: 'b1',
          fromStatus: 'PENDING_PAYMENT',
          toStatus: 'CONFIRMED',
          changedById: null,
          reason: null,
        },
      });
      expect(writes[2]!.data).toMatchObject({
        type: 'booking.confirmed',
        payload: {
          bookingId: 'b1',
          from: 'PENDING_PAYMENT',
          status: 'CONFIRMED',
          actorRole: 'SYSTEM',
        },
      });
    });

    it('al cancelar guarda quién y con qué rol (sin perder el resto de metadata)', async () => {
      const { machine, tx, writes } = build({ status: 'CONFIRMED' });
      await machine.transition(
        tx,
        'b1',
        'CANCELLED',
        { userId: 'u1', role: 'BARBERSHOP' },
        'motivo',
      );
      expect(writes[0]!.data).toEqual({
        where: { id: 'b1' },
        data: {
          status: 'CANCELLED',
          cancelledById: 'u1',
          cancelReason: 'motivo',
          metadata: { request: { a: 1 }, cancelledByRole: 'BARBERSHOP' },
        },
      });
    });

    it('rechaza transiciones no permitidas y reservas inexistentes, sin escribir nada', async () => {
      const done = build({ status: 'EXPIRED' });
      expect(await codeOf(done.machine.transition(done.tx, 'b1', 'CONFIRMED', SYSTEM_ACTOR))).toBe(
        'INVALID_STATE_TRANSITION',
      );
      expect(done.writes).toEqual([]);
      const missing = build(null);
      expect(
        await codeOf(missing.machine.transition(missing.tx, 'b1', 'EXPIRED', SYSTEM_ACTOR)),
      ).toBe('NOT_FOUND');
    });

    it('ATTENDED y NO_SHOW solo después de la hora de inicio', async () => {
      for (const to of ['ATTENDED', 'NO_SHOW'] as const) {
        const before = build({ status: 'CONFIRMED' }, START - 1);
        expect(await codeOf(before.machine.transition(before.tx, 'b1', to, SYSTEM_ACTOR))).toBe(
          'INVALID_STATE_TRANSITION',
        );
        const after = build({ status: 'CONFIRMED' }, START);
        expect(await codeOf(after.machine.transition(after.tx, 'b1', to, SYSTEM_ACTOR))).toBe('ok');
      }
    });

    it('recordCreation: historial null → PENDING_PAYMENT y evento booking.created', async () => {
      const { machine, tx, writes } = build(null);
      await machine.recordCreation(
        tx,
        { id: 'b1', barbershopId: 'shop', barberId: 'barber', clientId: 'client' },
        { userId: 'client', role: 'CLIENT' },
      );
      expect(writes.map((w) => w.kind)).toEqual(['history', 'outbox']);
      expect(writes[1]!.data).toMatchObject({ type: 'booking.created' });
    });
  });
});
