import {
  dayOfWeekAt,
  dayOfWeekOf,
  localDateOf,
  localDayBounds,
  localInstant,
  toDayOfWeek,
  windowsOn,
} from './local-time';

const LIMA = 'America/Lima';

describe('día de la semana: 0 = domingo … 6 = sábado (convención de Charles)', () => {
  it('convierte los siete días de luxon (1 = lunes … 7 = domingo)', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(toDayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it.each([0, 8, 1.5])('rechaza un día de luxon inválido: %p', (w) => {
    expect(() => toDayOfWeek(w)).toThrow(RangeError);
  });

  it.each([
    ['2030-01-06', 0, 'domingo'],
    ['2030-01-07', 1, 'lunes'],
    ['2030-01-08', 2, 'martes'],
    ['2030-01-09', 3, 'miércoles'],
    ['2030-01-10', 4, 'jueves'],
    ['2030-01-11', 5, 'viernes'],
    ['2030-01-12', 6, 'sábado'],
  ])('%s es %i (%s)', (date, expected) => {
    expect(dayOfWeekOf(date, LIMA)).toBe(expected);
  });

  it('el día local puede diferir del día UTC: sábado 21:00 en Lima es domingo 02:00Z', () => {
    const instant = Date.parse('2030-01-13T02:00:00Z'); // domingo en UTC
    expect(new Date(instant).getUTCDay()).toBe(0);
    expect(dayOfWeekAt(instant, LIMA)).toBe(6); // sábado en Lima
    expect(localDateOf(instant, LIMA)).toBe('2030-01-12');
    // Y al revés, al este de UTC: lunes 08:00 en Tokio es domingo 23:00Z.
    const tokyo = Date.parse('2030-01-06T23:00:00Z');
    expect(new Date(tokyo).getUTCDay()).toBe(0);
    expect(dayOfWeekAt(tokyo, 'Asia/Tokyo')).toBe(1);
  });
});

describe('conversión de hora local a UTC', () => {
  it('el día local de Lima es de 05:00Z a 05:00Z', () => {
    expect(localDayBounds('2030-01-07', LIMA)).toEqual({
      start: Date.parse('2030-01-07T05:00:00Z'),
      end: Date.parse('2030-01-08T05:00:00Z'),
    });
  });

  it('un día de cambio de hora dura 23 o 25 horas (America/Santiago)', () => {
    const spring = localDayBounds('2030-09-08', 'America/Santiago'); // adelanta 1 h
    const fall = localDayBounds('2030-04-06', 'America/Santiago'); // atrasa 1 h (sábado a medianoche)
    expect((spring.end - spring.start) / 3600_000).toBe(23);
    expect((fall.end - fall.start) / 3600_000).toBe(25);
  });

  it('marca las horas locales que no existen en el salto de verano', () => {
    // Santiago: 2030-09-08 a las 00:00 pasa a 01:00 (no existe 00:30).
    expect(localInstant('2030-09-08', 30, 'America/Santiago').exists).toBe(false);
    expect(localInstant('2030-09-08', 90, 'America/Santiago').exists).toBe(true);
  });

  it('windowsOn solo toma las ventanas del día de la semana local', () => {
    const windows = [
      { dayOfWeek: 1 as const, start: '09:00', end: '13:00' },
      { dayOfWeek: 2 as const, start: '10:00', end: '11:00' },
    ];
    expect(windowsOn(windows, '2030-01-07', LIMA)).toEqual([
      { start: Date.parse('2030-01-07T14:00:00Z'), end: Date.parse('2030-01-07T18:00:00Z') },
    ]);
  });
});
