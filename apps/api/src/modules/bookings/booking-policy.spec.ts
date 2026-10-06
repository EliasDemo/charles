import type { BookingStatus } from '../../generated/prisma/enums';
import { cancellationDecision, parseDeadline } from './booking-policy';
import { orderByLoad } from './bookings.service';

const START = Date.parse('2030-01-07T15:00:00Z');
const MIN = 60_000;

const decide = (
  status: BookingStatus,
  by: 'CLIENT' | 'BARBERSHOP',
  now: number,
  deadlineMinutes: number | null = null,
) => cancellationDecision({ status, startAt: START, now, by, deadlineMinutes });

describe('RF-RES-005 reglas de cancelación', () => {
  describe('con el plazo sin definir (null, provisional)', () => {
    it('el cliente cancela una PENDING_PAYMENT siempre, incluso después del inicio', () => {
      expect(decide('PENDING_PAYMENT', 'CLIENT', START + 10 * MIN)).toEqual({ allowed: true });
    });

    it('el cliente cancela una CONFIRMED hasta que empiece', () => {
      expect(decide('CONFIRMED', 'CLIENT', START - 1)).toEqual({ allowed: true });
      expect(decide('CONFIRMED', 'CLIENT', START)).toEqual({
        allowed: false,
        reason: 'DEADLINE_PASSED',
      });
    });

    it('la barbería cancela hasta que empiece', () => {
      expect(decide('CONFIRMED', 'BARBERSHOP', START - 1).allowed).toBe(true);
      expect(decide('PENDING_PAYMENT', 'BARBERSHOP', START).allowed).toBe(false);
    });
  });

  describe('con plazo de N minutos', () => {
    it('el cliente solo hasta N minutos antes; la barbería no tiene ese límite', () => {
      expect(decide('CONFIRMED', 'CLIENT', START - 121 * MIN, 120).allowed).toBe(true);
      expect(decide('CONFIRMED', 'CLIENT', START - 120 * MIN, 120)).toEqual({
        allowed: false,
        reason: 'DEADLINE_PASSED',
      });
      expect(decide('CONFIRMED', 'BARBERSHOP', START - 10 * MIN, 120).allowed).toBe(true);
      expect(decide('PENDING_PAYMENT', 'CLIENT', START - 10 * MIN, 120).allowed).toBe(true);
    });
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

  it.each<[unknown, number | null]>([
    [null, null],
    [undefined, null],
    [120, 120],
    [0, 0],
    [-5, null],
    [2.5, null],
    ['120', null],
  ])('parseDeadline(%p) = %p', (value, expected) => {
    expect(parseDeadline(value)).toBe(expected);
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
