import type { BookingStatus } from '../../generated/prisma/enums';
import { cancellationDecision, noShowAllowed } from './booking-policy';
import { BOOKING_TX_OPTIONS, LOCK_TIMEOUT_MS, orderByLoad } from './bookings.service';

const START = Date.parse('2030-01-07T15:00:00Z');
const MIN = 60_000;

const decide = (status: BookingStatus, by: 'CLIENT' | 'BARBERSHOP', now: number) =>
  cancellationDecision({ status, startAt: START, now, by });

describe('RF-RES-005 quién puede cancelar y hasta cuándo (Fase 8A)', () => {
  it('el cliente cancela una PENDING_PAYMENT siempre, incluso después del inicio', () => {
    expect(decide('PENDING_PAYMENT', 'CLIENT', START + 10 * MIN)).toEqual({ allowed: true });
  });

  it('el cliente cancela una CONFIRMED hasta la hora de inicio (aunque sea sin devolución)', () => {
    expect(decide('CONFIRMED', 'CLIENT', START - 1)).toEqual({ allowed: true });
    expect(decide('CONFIRMED', 'CLIENT', START)).toEqual({
      allowed: false,
      reason: 'ALREADY_STARTED',
    });
  });

  it('la barbería cancela hasta la hora de inicio', () => {
    expect(decide('CONFIRMED', 'BARBERSHOP', START - 1).allowed).toBe(true);
    expect(decide('PENDING_PAYMENT', 'BARBERSHOP', START).allowed).toBe(false);
  });

  it.each<[BookingStatus, string]>([
    ['CANCELLED', 'ALREADY_CANCELLED'],
    ['ATTENDED', 'NOT_CANCELLABLE'],
    ['NO_SHOW', 'NOT_CANCELLABLE'],
    ['EXPIRED', 'NOT_CANCELLABLE'],
  ])('%s no se puede cancelar (%s)', (status, reason) => {
    expect(decide(status, 'CLIENT', START - 60 * MIN)).toEqual({ allowed: false, reason });
    expect(decide(status, 'BARBERSHOP', START - 60 * MIN)).toEqual({ allowed: false, reason });
  });
});

describe('inasistencia: de 15 minutos a 24 horas después del inicio (inclusivos)', () => {
  const allowed = (now: number, status: BookingStatus = 'CONFIRMED') =>
    noShowAllowed({ status, startAt: START, now, afterMinutes: 15, windowHours: 24 });

  it.each<[string, number, boolean]>([
    ['antes del inicio', START - MIN, false],
    ['a los 14 min', START + 14 * MIN, false],
    ['a los 15 min exactos', START + 15 * MIN, true],
    ['a las 24 h exactas', START + 24 * 60 * MIN, true],
    ['pasadas las 24 h', START + 24 * 60 * MIN + 1, false],
  ])('%s', (_case, now, expected) => {
    expect(allowed(now)).toBe(expected);
  });

  it('solo reservas confirmadas', () => {
    for (const status of ['PENDING_PAYMENT', 'CANCELLED', 'EXPIRED', 'ATTENDED'] as const) {
      expect(allowed(START + 30 * MIN, status)).toBe(false);
    }
  });
});

describe('"cualquier barbero": orderByLoad', () => {
  it('menos reservas activas primero; a igualdad, por ID', () => {
    expect(
      orderByLoad(
        ['c', 'a', 'b'],
        new Map([
          ['a', 2],
          ['b', 0],
          ['c', 0],
        ]),
      ),
    ).toEqual(['b', 'c', 'a']);
    expect(orderByLoad(['c', 'a', 'b'], new Map())).toEqual(['a', 'b', 'c']);
  });

  it('no modifica la lista recibida', () => {
    const input = ['b', 'a'];
    orderByLoad(input, new Map());
    expect(input).toEqual(['b', 'a']);
  });
});

describe('transacción de creación bajo carga', () => {
  it('plazos holgados: más que los valores por defecto de Prisma (2 s / 5 s)', () => {
    expect(BOOKING_TX_OPTIONS.maxWait).toBeGreaterThan(2_000);
    expect(BOOKING_TX_OPTIONS.timeout).toBeGreaterThan(5_000);
  });

  it('la espera de un bloqueo (5 s) es menor que el plazo de la transacción', () => {
    expect(LOCK_TIMEOUT_MS).toBeLessThan(BOOKING_TX_OPTIONS.timeout);
  });
});
