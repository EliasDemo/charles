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
