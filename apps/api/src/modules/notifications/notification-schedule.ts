import { DateTime } from 'luxon';

/**
 * Reglas puras de horario de las notificaciones (Fase 10). Sin base ni reloj.
 * - Horario silencioso (`notifications.quiet_start` / `quiet_end`, 22:00–08:00 en la zona de la
 *   barbería): los push no urgentes se aplazan hasta su fin. Los urgentes, la bandeja y el correo
 *   no esperan.
 * - Recordatorios (`notifications.reminder_hours`, 24 y 2 h antes): si su hora cae en el horario
 *   silencioso, **se adelantan** al último momento permitido anterior; nunca se descartan por eso.
 */
export const NOTIFICATION_DEFAULTS = {
  reminderHours: [24, 2] as readonly number[],
  quietStart: '22:00',
  quietEnd: '08:00',
  retentionDays: 90,
} as const;

export interface QuietHours {
  /** "HH:mm" local. */
  start: string;
  end: string;
  timezone: string;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(hhmm: string): number {
  const match = HH_MM.exec(hhmm);
  if (!match) throw new Error(`Hora inválida: ${hhmm}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutos desde la medianoche local. */
function localMinutes(ms: number, timezone: string): number {
  const local = DateTime.fromMillis(ms, { zone: timezone });
  return local.hour * 60 + local.minute;
}

/** Si el instante cae en el horario silencioso (que puede cruzar la medianoche). */
export function inQuietHours(ms: number, quiet: QuietHours): boolean {
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false; // sin horario silencioso
  const now = localMinutes(ms, quiet.timezone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Primer instante permitido en o después de `ms` (para aplazar un push no urgente). */
export function nextAllowedAt(ms: number, quiet: QuietHours): number {
  if (!inQuietHours(ms, quiet)) return ms;
  const end = minutesOf(quiet.end);
  let candidate = DateTime.fromMillis(ms, { zone: quiet.timezone }).set({
    hour: Math.floor(end / 60),
    minute: end % 60,
    second: 0,
    millisecond: 0,
  });
  if (candidate.toMillis() <= ms) candidate = candidate.plus({ days: 1 });
  return candidate.toMillis();
}

/** Último instante permitido en o antes de `ms` (para adelantar un recordatorio). */
export function lastAllowedAt(ms: number, quiet: QuietHours): number {
  if (!inQuietHours(ms, quiet)) return ms;
  const start = minutesOf(quiet.start);
  let quietStart = DateTime.fromMillis(ms, { zone: quiet.timezone }).set({
    hour: Math.floor(start / 60),
    minute: start % 60,
    second: 0,
    millisecond: 0,
  });
  if (quietStart.toMillis() > ms) quietStart = quietStart.minus({ days: 1 });
  // Un minuto antes de que empiece el silencio.
  return quietStart.toMillis() - 60_000;
}

/** Cuándo se envía el recordatorio de `hours` horas antes de `startAt`. */
export function reminderSendAt(startAt: number, hours: number, quiet: QuietHours): number {
  return lastAllowedAt(startAt - hours * 3_600_000, quiet);
}

/**
 * Si el recordatorio toca ahora. Nunca de una reserva que ya empezó; nunca si su momento ya
 * había pasado cuando se confirmó la reserva (no se manda un "faltan 24 h" a 3 h de la cita).
 */
export function reminderDue(input: {
  startAt: number;
  confirmedAt: number;
  hours: number;
  now: number;
  quiet: QuietHours;
}): boolean {
  if (input.now >= input.startAt) return false;
  const sendAt = reminderSendAt(input.startAt, input.hours, input.quiet);
  return sendAt <= input.now && sendAt >= input.confirmedAt;
}

/** Valida y normaliza la lista de horas de recordatorio (enteros 1–168, sin repetir). */
export function normalizeReminderHours(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  if (!value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 168)) {
    return null;
  }
  return [...new Set(value as number[])].sort((a, b) => b - a);
}

export function isValidHhMm(value: unknown): value is string {
  return typeof value === 'string' && HH_MM.test(value);
}
