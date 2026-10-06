import { DateTime } from 'luxon';
import {
  type AvailabilityInput,
  type BarberAvailabilityInput,
  computeSlots,
} from './compute-slots';
import type { WeeklyWindow } from './local-time';

const LIMA = 'America/Lima';
const MONDAY = '2030-01-07'; // lunes
const MON = 1 as const;

/** Instante de una hora local en Lima el lunes de prueba (u otra fecha/zona). */
const at = (hhmm: string, date = MONDAY, zone = LIMA) =>
  DateTime.fromISO(`${date}T${hhmm}`, { zone }).toMillis();
const local = (ms: number, zone = LIMA) => DateTime.fromMillis(ms, { zone }).toFormat('HH:mm');
const w = (
  start: string,
  end: string,
  dayOfWeek: WeeklyWindow['dayOfWeek'] = MON,
): WeeklyWindow => ({
  dayOfWeek,
  start,
  end,
});

function barber(overrides: Partial<BarberAvailabilityInput> = {}): BarberAvailabilityInput {
  return { id: 'b1', schedule: null, blocks: [], busy: [], ...overrides };
}

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    timezone: LIMA,
    localDate: MONDAY,
    now: at('00:00', '2030-01-01'),
    shopStatus: 'OPEN',
    businessHours: [w('09:00', '13:00')],
    shopBlocks: [],
    barbers: [barber()],
    serviceDurationMinutes: 30,
    slotIntervalMinutes: 15,
    minLeadMinutes: 0,
    ...overrides,
  };
}

const starts = (i: AvailabilityInput) => computeSlots(i).map((s) => local(s.start, i.timezone));

describe('computeSlots — casos del plan (CLAUDE.md §9)', () => {
  it.each(['TEMPORARILY_CLOSED', 'SUSPENDED', 'PENDING_REVIEW'] as const)(
    '1. barbería %s: ningún turno',
    (shopStatus) => {
      expect(computeSlots(input({ shopStatus }))).toEqual([]);
    },
  );

  it('2. día en que la barbería no atiende: ningún turno', () => {
    expect(computeSlots(input({ businessHours: [w('09:00', '13:00', 2)] }))).toEqual([]);
  });

  it('3. horario simple: servicio de 30 min cada 15 min de 09:00 a 12:30', () => {
    const slots = computeSlots(input());
    expect(slots.map((s) => local(s.start))).toEqual([
      '09:00',
      '09:15',
      '09:30',
      '09:45',
      '10:00',
      '10:15',
      '10:30',
      '10:45',
      '11:00',
      '11:15',
      '11:30',
      '11:45',
      '12:00',
      '12:15',
      '12:30',
    ]);
    expect(slots[0]).toEqual({ start: at('09:00'), end: at('09:30'), barberIds: ['b1'] });
  });

  it('4. descanso: turno partido 09–13 y 14–20 no ofrece nada que toque 13:00–14:00', () => {
    const result = starts(
      input({
        businessHours: [w('09:00', '20:00')],
        barbers: [barber({ schedule: [w('09:00', '13:00'), w('14:00', '20:00')] })],
      }),
    );
    expect(result).toContain('12:30');
    expect(result).not.toContain('12:45');
    expect(result).not.toContain('13:30');
    expect(result).toContain('14:00');
  });

  it('5. bloqueo parcial 10:20–11:05: desaparecen los turnos que lo tocan', () => {
    const result = starts(
      input({ barbers: [barber({ blocks: [{ start: at('10:20'), end: at('11:05') }] })] }),
    );
    expect(result).toContain('09:45'); // 09:45–10:15
    expect(result).not.toContain('10:00'); // 10:00–10:30 toca el bloqueo
    expect(result).not.toContain('11:00');
    expect(result).toContain('11:15');
  });

  it('6. un bloqueo de toda la barbería afecta a todos los barberos', () => {
    const slots = computeSlots(
      input({
        barbers: [barber({ id: 'a' }), barber({ id: 'b' })],
        shopBlocks: [{ start: at('09:00'), end: at('12:00') }],
      }),
    );
    expect(slots.map((s) => local(s.start))).toEqual(['12:00', '12:15', '12:30']);
    expect(slots[0]!.barberIds).toEqual(['a', 'b']);
  });

  it('7. bloqueo de día completo (feriado): ningún turno', () => {
    const holiday = { start: at('00:00'), end: at('00:00', '2030-01-08') };
    expect(computeSlots(input({ shopBlocks: [holiday] }))).toEqual([]);
  });

  it('8. bloqueos solapados se tratan como su unión', () => {
    const result = starts(
      input({
        barbers: [
          barber({
            blocks: [
              { start: at('09:00'), end: at('10:00') },
              { start: at('09:30'), end: at('11:00') },
            ],
          }),
        ],
      }),
    );
    expect(result[0]).toBe('11:00');
  });

  it('9. reservas contiguas: 10:00–10:30 y 10:30–11:00 ocupadas; 11:00 libre; 10:15 no', () => {
    const result = starts(
      input({
        barbers: [
          barber({
            busy: [
              { start: at('10:00'), end: at('10:30') },
              { start: at('10:30'), end: at('11:00') },
            ],
          }),
        ],
      }),
    );
    expect(result).toContain('09:30'); // termina justo a las 10:00
    expect(result).not.toContain('10:15');
    expect(result).not.toContain('10:45');
    expect(result).toContain('11:00');
  });

  it('10. solo bloquean las reservas que recibe como ocupadas (la carga filtra estados)', () => {
    const free = starts(input());
    const busy = starts(
      input({ barbers: [barber({ busy: [{ start: at('09:00'), end: at('13:00') }] })] }),
    );
    expect(free.length).toBeGreaterThan(0);
    expect(busy).toEqual([]);
  });

  it('11. servicio más largo que el hueco no se ofrece', () => {
    const result = starts(
      input({
        serviceDurationMinutes: 60,
        barbers: [barber({ busy: [{ start: at('09:45'), end: at('13:00') }] })],
      }),
    );
    expect(result).toEqual([]); // hueco 09:00–09:45 (45 min)
  });

  it('12. duración que no es múltiplo del intervalo: inicios en la cuadrícula y turno completo', () => {
    const slots = computeSlots(input({ serviceDurationMinutes: 45 }));
    expect(slots.at(-1)).toEqual({ start: at('12:15'), end: at('13:00'), barberIds: ['b1'] });
  });

  it('13. horario del barbero fuera del de la barbería: solo cuenta la intersección', () => {
    const result = starts(input({ barbers: [barber({ schedule: [w('07:00', '10:00')] })] }));
    expect(result).toEqual(['09:00', '09:15', '09:30']);
  });

  it('14. barbero sin horario propio hereda el de la barbería', () => {
    expect(starts(input({ barbers: [barber({ schedule: null })] }))).toHaveLength(15);
  });

  it('14b. barbero con horario propio que no atiende ese día: sin turnos', () => {
    expect(starts(input({ barbers: [barber({ schedule: [w('09:00', '13:00', 2)] })] }))).toEqual(
      [],
    );
  });

  it('15. varios barberos: turnos combinados con la lista de libres', () => {
    const slots = computeSlots(
      input({
        businessHours: [w('09:00', '10:00')],
        barbers: [
          barber({ id: 'b', busy: [{ start: at('09:00'), end: at('09:30') }] }),
          barber({ id: 'a' }),
        ],
      }),
    );
    expect(slots.map((s) => [local(s.start), s.barberIds])).toEqual([
      ['09:00', ['a']],
      ['09:15', ['a']],
      ['09:30', ['a', 'b']],
    ]);
  });

  it('16. hoy: descarta turnos pasados y aplica la anticipación mínima', () => {
    expect(starts(input({ now: at('10:07') }))[0]).toBe('10:15');
    expect(starts(input({ now: at('10:07'), minLeadMinutes: 60 }))[0]).toBe('11:15');
    expect(starts(input({ now: at('10:15') }))[0]).toBe('10:15'); // empieza justo ahora
  });

  it('17. cambio de día UTC: cierre 20:00 en Lima = 01:00Z del día siguiente', () => {
    const slots = computeSlots(input({ businessHours: [w('18:00', '20:00')] }));
    const last = slots.at(-1)!;
    expect(new Date(last.end).toISOString()).toBe('2030-01-08T01:00:00.000Z');
    expect(DateTime.fromMillis(last.start, { zone: LIMA }).toISODate()).toBe(MONDAY);
  });

  it('18. una reserva que cruza la medianoche local se recorta al día pedido', () => {
    const slots = computeSlots(
      input({
        businessHours: [w('00:00', '02:00')],
        barbers: [barber({ busy: [{ start: at('23:00', '2030-01-06'), end: at('01:00') }] })],
      }),
    );
    expect(slots.map((s) => local(s.start))[0]).toBe('01:00');
  });

  it('19. zonas horarias: el mismo horario local da instantes UTC distintos', () => {
    const tokyo = computeSlots(input({ timezone: 'Asia/Tokyo' }))[0]!;
    const lima = computeSlots(input())[0]!;
    expect(new Date(tokyo.start).toISOString()).toBe('2030-01-07T00:00:00.000Z'); // 09:00 JST
    expect(new Date(lima.start).toISOString()).toBe('2030-01-07T14:00:00.000Z'); // 09:00 PET
  });

  it('20. cambio de horario de verano (America/Santiago): horas inexistentes y día de 25 h', () => {
    const zone = 'America/Santiago';
    // 2030-09-08 (domingo): 00:00 → 01:00. Ventana 00:00–02:00 solo ofrece desde 01:00.
    const spring = computeSlots(
      input({ timezone: zone, localDate: '2030-09-08', businessHours: [w('00:00', '02:00', 0)] }),
    );
    expect(spring.map((s) => local(s.start, zone))).toEqual(['01:00', '01:15', '01:30']);
    for (const s of spring) expect(s.end - s.start).toBe(30 * 60_000); // duración real

    // 2030-04-07 (domingo), tras el atraso de la medianoche anterior: sin duplicados.
    const fall = computeSlots(
      input({ timezone: zone, localDate: '2030-04-07', businessHours: [w('09:00', '10:00', 0)] }),
    );
    expect(fall.map((s) => local(s.start, zone))).toEqual(['09:00', '09:15', '09:30']);
  });

  it('21. cuadrícula alineada al reloj: horario desde 09:10 empieza a las 09:15', () => {
    expect(starts(input({ businessHours: [w('09:10', '10:00')] }))).toEqual(['09:15', '09:30']);
  });

  it('22. barbero sin ningún hueco no aparece', () => {
    const slots = computeSlots(
      input({
        barbers: [
          barber({ id: 'ocupado', busy: [{ start: at('09:00'), end: at('13:00') }] }),
          barber({ id: 'libre' }),
        ],
      }),
    );
    expect(new Set(slots.flatMap((s) => s.barberIds))).toEqual(new Set(['libre']));
  });

  it('sin barberos: ningún turno', () => {
    expect(computeSlots(input({ barbers: [] }))).toEqual([]);
  });
});
