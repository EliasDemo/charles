import { DateTime } from 'luxon';
import type { Interval } from './intervals';

/** Convención de Charles (CLAUDE.md §7.1): 0 = domingo … 6 = sábado. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Ventana semanal en hora local de la barbería: 'HH:mm', sin cruzar la medianoche. */
export interface WeeklyWindow {
  dayOfWeek: DayOfWeek;
  start: string;
  end: string;
}

const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Las conversiones de zona horaria de luxon son caras (cada una consulta Intl): el cálculo de
 * turnos las repite miles de veces con las mismas entradas. Son funciones puras, así que se
 * memorizan en una caché acotada que se vacía al llenarse.
 */
const CACHE_LIMIT = 20_000;
function memo<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const cache = new Map<string, R>();
  return (...args: A) => {
    const key = args.join('|');
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    const value = fn(...args);
    cache.set(key, value);
    return value;
  };
}

/**
 * Única conversión del día de la semana: luxon usa 1 = lunes … 7 = domingo; Charles usa
 * 0 = domingo … 6 = sábado. Toda conversión pasa por aquí.
 */
export function toDayOfWeek(luxonWeekday: number): DayOfWeek {
  if (!Number.isInteger(luxonWeekday) || luxonWeekday < 1 || luxonWeekday > 7) {
    throw new RangeError(`Día de semana de luxon inválido: ${luxonWeekday}`);
  }
  return (luxonWeekday % 7) as DayOfWeek;
}

export function isLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value);
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

/** Día de la semana (convención de Charles) de una fecha local. */
export const dayOfWeekOf = memo((localDate: string, timezone: string): DayOfWeek =>
  toDayOfWeek(DateTime.fromISO(localDate, { zone: timezone }).weekday),
);

/** Día de la semana local de un instante, en la zona de la barbería (no en UTC). */
export function dayOfWeekAt(instant: number, timezone: string): DayOfWeek {
  return toDayOfWeek(DateTime.fromMillis(instant, { zone: timezone }).weekday);
}

/** Fecha local (YYYY-MM-DD) de un instante en la zona dada. */
export function localDateOf(instant: number, timezone: string): string {
  return DateTime.fromMillis(instant, { zone: timezone }).toISODate()!;
}

export function addDays(localDate: string, days: number): string {
  return DateTime.fromISO(localDate).plus({ days }).toISODate()!;
}

/** El día local completo [00:00, 24:00) como intervalo UTC (dura 23 o 25 h en días de cambio de hora). */
const dayBounds = memo((localDate: string, timezone: string): Readonly<Interval> => {
  const start = DateTime.fromISO(localDate, { zone: timezone }).startOf('day');
  return Object.freeze({
    start: start.toMillis(),
    end: start.plus({ days: 1 }).startOf('day').toMillis(),
  });
});

export function localDayBounds(localDate: string, timezone: string): Interval {
  return { ...dayBounds(localDate, timezone) };
}

/**
 * Instante UTC de una hora local en una fecha. Si la hora no existe (salto de verano hacia
 * adelante) luxon la mueve al primer instante válido; si existe dos veces, usa la primera.
 * Devuelve también si la hora local existe tal cual.
 */
const instantOf = memo(
  (
    localDate: string,
    minutesFromMidnight: number,
    timezone: string,
  ): Readonly<{ instant: number; exists: boolean }> =>
    Object.freeze(computeInstant(localDate, minutesFromMidnight, timezone)),
);

export function localInstant(
  localDate: string,
  minutesFromMidnight: number,
  timezone: string,
): { instant: number; exists: boolean } {
  return { ...instantOf(localDate, minutesFromMidnight, timezone) };
}

function computeInstant(
  localDate: string,
  minutesFromMidnight: number,
  timezone: string,
): { instant: number; exists: boolean } {
  const day = DateTime.fromISO(localDate, { zone: timezone }).startOf('day');
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  const dt = DateTime.fromObject(
    { year: day.year, month: day.month, day: day.day, hour, minute },
    { zone: timezone },
  );
  return { instant: dt.toMillis(), exists: dt.hour === hour && dt.minute === minute };
}

/** Ventanas semanales del día pedido, convertidas a intervalos UTC. */
export function windowsOn(
  windows: readonly WeeklyWindow[],
  localDate: string,
  timezone: string,
): Interval[] {
  const day = dayOfWeekOf(localDate, timezone);
  return windows
    .filter((w) => w.dayOfWeek === day)
    .map((w) => ({
      start: localInstant(localDate, minutesOf(w.start), timezone).instant,
      end: localInstant(localDate, minutesOf(w.end), timezone).instant,
    }))
    .filter((i) => i.end > i.start);
}
