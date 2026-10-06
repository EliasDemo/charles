import fc from 'fast-check';
import { DateTime } from 'luxon';
import { type AvailabilityInput, computeSlots } from './compute-slots';
import type { Interval } from './intervals';
import type { DayOfWeek, WeeklyWindow } from './local-time';

/**
 * Pruebas basadas en propiedades: entradas al azar (horarios, bloqueos, reservas, duraciones y
 * zonas horarias, incluidas zonas con cambio de hora y desfases de 30/45 min).
 */
const ZONES = [
  'America/Lima',
  'America/Santiago',
  'America/New_York',
  'Europe/Madrid',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'UTC',
];
// Incluye días de cambio de hora en Santiago, Nueva York y Madrid.
const DATES = [
  '2030-01-07',
  '2030-03-10',
  '2030-03-31',
  '2030-04-07',
  '2030-09-08',
  '2030-11-03',
  '2030-06-15',
];

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Ventana local en múltiplos de 5 min, sin cruzar la medianoche. */
const windowArb = (dayOfWeek: DayOfWeek): fc.Arbitrary<WeeklyWindow> =>
  fc.tuple(fc.integer({ min: 0, max: 286 }), fc.integer({ min: 1, max: 100 })).map(([a, len]) => {
    const start = a * 5;
    const end = Math.min(start + len * 5, 23 * 60 + 55);
    return { dayOfWeek, start: hhmm(start), end: hhmm(Math.max(end, start + 5)) };
  });

const intervalArb = (center: number): fc.Arbitrary<Interval> =>
  fc
    .tuple(fc.integer({ min: -36 * 60, max: 36 * 60 }), fc.integer({ min: 5, max: 6 * 60 }))
    .map(([offset, len]) => ({
      start: center + offset * 60_000,
      end: center + (offset + len) * 60_000,
    }));

const inputArb: fc.Arbitrary<AvailabilityInput> = fc
  .record({ zone: fc.constantFrom(...ZONES), date: fc.constantFrom(...DATES) })
  .chain(({ zone, date }) => {
    const dow = (DateTime.fromISO(date, { zone }).weekday % 7) as DayOfWeek;
    const center = DateTime.fromISO(`${date}T12:00`, { zone }).toMillis();
    const otherDay = ((dow + 1) % 7) as DayOfWeek;
    const windows = fc.array(fc.oneof(windowArb(dow), windowArb(otherDay)), { maxLength: 4 });
    return fc.record({
      timezone: fc.constant(zone),
      localDate: fc.constant(date),
      now: fc.integer({ min: -48 * 60, max: 48 * 60 }).map((m) => center + m * 60_000),
      shopStatus: fc.constantFrom<AvailabilityInput['shopStatus']>(
        'OPEN',
        'OPEN',
        'OPEN',
        'TEMPORARILY_CLOSED',
      ),
      businessHours: windows,
      shopBlocks: fc.array(intervalArb(center), { maxLength: 3 }),
      barbers: fc.uniqueArray(
        fc.record({
          id: fc.constantFrom('a', 'b', 'c', 'd'),
          schedule: fc.option(windows, { nil: null }),
          blocks: fc.array(intervalArb(center), { maxLength: 3 }),
          busy: fc.array(intervalArb(center), { maxLength: 4 }),
        }),
        { selector: (b) => b.id, maxLength: 3 },
      ),
      serviceDurationMinutes: fc.integer({ min: 1, max: 48 }).map((n) => n * 5),
      slotIntervalMinutes: fc.constantFrom(5, 10, 15, 20, 30),
      minLeadMinutes: fc.integer({ min: 0, max: 180 }),
    });
  });

/** Ventanas del día local del turno, convertidas con luxon de forma independiente del motor. */
function windowsOfDay(windows: readonly WeeklyWindow[], date: string, zone: string): Interval[] {
  const dow = DateTime.fromISO(date, { zone }).weekday % 7;
  return windows
    .filter((w) => w.dayOfWeek === dow)
    .map((w) => ({
      start: DateTime.fromISO(`${date}T${w.start}`, { zone }).toMillis(),
      end: DateTime.fromISO(`${date}T${w.end}`, { zone }).toMillis(),
    }));
}

/**
 * Varias filas contiguas o solapadas de un mismo día forman un tramo continuo de trabajo
 * (09:00–10:00 + 10:00–11:00 = 09:00–11:00). Fusión escrita aparte del motor, a propósito.
 */
function merged(list: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const i of [...list].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

const overlapsAny = (s: Interval, list: readonly Interval[]) =>
  list.some((i) => s.start < i.end && i.start < s.end);
const insideAny = (s: Interval, list: readonly Interval[]) =>
  list.some((i) => i.start <= s.start && s.end <= i.end);

const RUNS = { numRuns: 400 };

/** Contraejemplo real encontrado por fast-check: dos filas contiguas forman un tramo continuo. */
const CONTIGUOUS_ROWS: AvailabilityInput = {
  timezone: 'Asia/Tokyo',
  localDate: '2030-04-07',
  now: 1901727000000,
  shopStatus: 'OPEN',
  businessHours: [{ dayOfWeek: 0, start: '00:00', end: '02:40' }],
  shopBlocks: [],
  barbers: [
    {
      id: 'a',
      schedule: [
        { dayOfWeek: 0, start: '02:35', end: '02:40' },
        { dayOfWeek: 0, start: '02:05', end: '02:35' },
      ],
      blocks: [],
      busy: [],
    },
  ],
  serviceDurationMinutes: 10,
  slotIntervalMinutes: 5,
  minLeadMinutes: 0,
};

describe('computeSlots — propiedades (fast-check)', () => {
  it('(a) ningún turno se solapa con reservas o bloqueos del barbero ni con bloqueos de la barbería', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        for (const slot of computeSlots(input)) {
          if (overlapsAny(slot, input.shopBlocks)) return false;
          for (const id of slot.barberIds) {
            const b = input.barbers.find((x) => x.id === id)!;
            if (overlapsAny(slot, b.busy) || overlapsAny(slot, b.blocks)) return false;
          }
        }
        return true;
      }),
      RUNS,
    );
  });

  it('(b) todo turno cae completo dentro del horario efectivo del barbero y de la barbería', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const shop = merged(windowsOfDay(input.businessHours, input.localDate, input.timezone));
        for (const slot of computeSlots(input)) {
          if (!insideAny(slot, shop)) return false;
          for (const id of slot.barberIds) {
            const b = input.barbers.find((x) => x.id === id)!;
            const own = b.schedule
              ? merged(windowsOfDay(b.schedule, input.localDate, input.timezone))
              : shop;
            if (!insideAny(slot, own)) return false;
          }
        }
        return true;
      }),
      RUNS,
    );
  });

  it('(c) ningún turno empieza antes de now + anticipación mínima', () => {
    fc.assert(
      fc.property(inputArb, (input) =>
        computeSlots(input).every((s) => s.start >= input.now + input.minLeadMinutes * 60_000),
      ),
      RUNS,
    );
  });

  it('(d) todo inicio está en la cuadrícula del reloj local y en el día pedido', () => {
    fc.assert(
      fc.property(inputArb, (input) =>
        computeSlots(input).every((s) => {
          const local = DateTime.fromMillis(s.start, { zone: input.timezone });
          return (
            (local.hour * 60 + local.minute) % input.slotIntervalMinutes === 0 &&
            local.second === 0 &&
            local.toISODate() === input.localDate &&
            s.end - s.start === input.serviceDurationMinutes * 60_000
          );
        }),
      ),
      RUNS,
    );
  });

  it('(e) la salida está ordenada, sin inicios duplicados ni barberos repetidos', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const slots = computeSlots(input);
        return slots.every(
          (s, i) =>
            (i === 0 || slots[i - 1]!.start < s.start) &&
            s.barberIds.length > 0 &&
            new Set(s.barberIds).size === s.barberIds.length &&
            [...s.barberIds].sort().join() === s.barberIds.join(),
        );
      }),
      RUNS,
    );
  });

  it('(f) la misma entrada produce la misma salida', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const copy = structuredClone(input);
        return JSON.stringify(computeSlots(input)) === JSON.stringify(computeSlots(copy));
      }),
      RUNS,
    );
  });

  it('una barbería que no está OPEN nunca ofrece turnos', () => {
    fc.assert(
      fc.property(inputArb, (input) =>
        input.shopStatus === 'OPEN' ? true : computeSlots(input).length === 0,
      ),
      RUNS,
    );
  });
});

describe('computeSlots — regresiones encontradas por fast-check', () => {
  it('dos filas contiguas del horario forman un tramo continuo: 02:30–02:40 es válido', () => {
    const starts = computeSlots(CONTIGUOUS_ROWS).map((s) =>
      DateTime.fromMillis(s.start, { zone: 'Asia/Tokyo' }).toFormat('HH:mm'),
    );
    expect(starts).toContain('02:30');
    expect(starts.at(-1)).toBe('02:30');
  });
});
