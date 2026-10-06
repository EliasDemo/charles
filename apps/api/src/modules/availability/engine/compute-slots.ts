import type { BarbershopStatus } from '../../../generated/prisma/enums';
import { type Interval, intersect, subtract, union } from './intervals';
import { localDayBounds, localInstant, type WeeklyWindow, windowsOn } from './local-time';

export interface BarberAvailabilityInput {
  id: string;
  /** null = sin horario propio: hereda el de la barbería (CLAUDE.md §4.1). */
  schedule: readonly WeeklyWindow[] | null;
  /** Bloqueos del barbero (UTC). */
  blocks: readonly Interval[];
  /** Reservas que bloquean: CONFIRMED y PENDING_PAYMENT no vencidas (UTC). */
  busy: readonly Interval[];
}

export interface AvailabilityInput {
  timezone: string;
  /** Día pedido, en la fecha local de la barbería (YYYY-MM-DD). */
  localDate: string;
  /** Instante actual (UTC, ms). Entra como parámetro: la función es determinista. */
  now: number;
  shopStatus: BarbershopStatus;
  businessHours: readonly WeeklyWindow[];
  /** Bloqueos de toda la barbería (UTC). */
  shopBlocks: readonly Interval[];
  /** Solo barberos activos que realizan el servicio. */
  barbers: readonly BarberAvailabilityInput[];
  serviceDurationMinutes: number;
  slotIntervalMinutes: number;
  minLeadMinutes: number;
}

export interface Slot {
  start: number;
  end: number;
  /** Barberos libres en ese turno, ordenados. */
  barberIds: string[];
}

const MINUTE = 60_000;
const MINUTES_PER_DAY = 24 * 60;

/**
 * Turnos disponibles de un día (CLAUDE.md §9). Función pura: no lee la base ni el reloj.
 *
 * Por barbero: (su horario o el de la barbería) ∩ horario de la barbería
 *   − bloqueos de la barbería − bloqueos del barbero − reservas activas.
 * Los inicios siguen la cuadrícula del reloj local (múltiplos del intervalo) y el turno debe
 * caber completo. Se descartan los que empiezan antes de now + anticipación mínima.
 */
export function computeSlots(input: AvailabilityInput): Slot[] {
  if (input.shopStatus !== 'OPEN') return [];
  const { timezone, localDate } = input;

  const day = localDayBounds(localDate, timezone);
  const shopHours = union(windowsOn(input.businessHours, localDate, timezone));
  if (shopHours.length === 0) return [];

  const duration = input.serviceDurationMinutes * MINUTE;
  const earliestStart = input.now + input.minLeadMinutes * MINUTE;
  const grid = gridInstants(localDate, timezone, input.slotIntervalMinutes).filter(
    (start) => start >= earliestStart && start >= day.start && start < day.end,
  );

  const byStart = new Map<number, string[]>();
  for (const barber of input.barbers) {
    const own = barber.schedule ? windowsOn(barber.schedule, localDate, timezone) : shopHours;
    const free = subtract(intersect(own, shopHours), [
      ...input.shopBlocks,
      ...barber.blocks,
      ...barber.busy,
    ]);
    for (const start of grid) {
      const end = start + duration;
      if (free.some((f) => f.start <= start && end <= f.end)) {
        const ids = byStart.get(start) ?? [];
        ids.push(barber.id);
        byStart.set(start, ids);
      }
    }
  }

  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, ids]) => ({
      start,
      end: start + duration,
      barberIds: [...new Set(ids)].sort(),
    }));
}

/**
 * Inicios posibles del día: horas locales múltiplos del intervalo (09:00, 09:15…). Las horas
 * locales que no existen (salto de verano) se omiten; las repetidas aparecen una vez.
 */
export function gridInstants(
  localDate: string,
  timezone: string,
  intervalMinutes: number,
): number[] {
  const instants = new Set<number>();
  for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += intervalMinutes) {
    const { instant, exists } = localInstant(localDate, minutes, timezone);
    if (exists) instants.add(instant);
  }
  return [...instants].sort((a, b) => a - b);
}
