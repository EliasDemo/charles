import type { BookingStatus } from '../../generated/prisma/enums';

export type CancelDecision =
  | { allowed: true }
  | { allowed: false; reason: 'ALREADY_CANCELLED' | 'NOT_CANCELLABLE' | 'ALREADY_STARTED' };

/**
 * Quién puede cancelar y hasta cuándo (RF-RES-005, Fase 8A). La devolución no se decide aquí:
 * depende de la anticipación (`refund-policy.ts`).
 * - El cliente cancela una PENDING_PAYMENT siempre y una CONFIRMED hasta la hora de inicio
 *   (con menos de `refunds.partial_min_minutes`, sin devolución).
 * - La barbería (OWNER o MANAGER, con motivo) cancela hasta la hora de inicio.
 */
export function cancellationDecision(input: {
  status: BookingStatus;
  startAt: number;
  now: number;
  by: 'CLIENT' | 'BARBERSHOP';
}): CancelDecision {
  const { status, startAt, now, by } = input;
  if (status === 'CANCELLED') return { allowed: false, reason: 'ALREADY_CANCELLED' };
  if (status !== 'PENDING_PAYMENT' && status !== 'CONFIRMED') {
    return { allowed: false, reason: 'NOT_CANCELLABLE' };
  }
  if (by === 'CLIENT' && status === 'PENDING_PAYMENT') return { allowed: true };
  return now < startAt ? { allowed: true } : { allowed: false, reason: 'ALREADY_STARTED' };
}

export const NO_SHOW_DEFAULTS = { afterMinutes: 15, windowHours: 24 } as const;

/**
 * Inasistencia (Fase 8A): solo una reserva CONFIRMED, desde `afterMinutes` y hasta `windowHours`
 * después del inicio (ambos inclusivos). Sin devolución.
 */
export function noShowAllowed(input: {
  status: BookingStatus;
  startAt: number;
  now: number;
  afterMinutes: number;
  windowHours: number;
}): boolean {
  const { status, startAt, now, afterMinutes, windowHours } = input;
  return (
    status === 'CONFIRMED' &&
    now >= startAt + afterMinutes * 60_000 &&
    now <= startAt + windowHours * 3600_000
  );
}

export const ATTENDANCE_DEFAULTS = { autoCloseHours: 24, correctionHours: 48 } as const;

/**
 * Marcar ATTENDED (Fase 9): solo una reserva CONFIRMED, desde la hora de inicio y hasta
 * `booking.attendance_auto_close_hours` (24) después (ambos inclusivos). Pasado ese plazo, el
 * cierre automático la marca ATTENDED.
 */
export function attendedAllowed(input: {
  status: BookingStatus;
  startAt: number;
  now: number;
  autoCloseHours: number;
}): boolean {
  const { status, startAt, now, autoCloseHours } = input;
  return status === 'CONFIRMED' && now >= startAt && now <= startAt + autoCloseHours * 3600_000;
}

/**
 * Corregir ATTENDED ↔ NO_SHOW (Fase 9): solo la barbería, hasta
 * `booking.attendance_correction_hours` (48) después del inicio (inclusivo). Después, soporte.
 */
export function correctionAllowed(input: {
  status: BookingStatus;
  startAt: number;
  now: number;
  correctionHours: number;
}): boolean {
  const { status, startAt, now, correctionHours } = input;
  return (
    (status === 'ATTENDED' || status === 'NO_SHOW') && now <= startAt + correctionHours * 3600_000
  );
}
