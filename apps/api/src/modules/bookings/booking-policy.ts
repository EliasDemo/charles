import type { BookingStatus } from '../../generated/prisma/enums';

export type CancelDecision =
  | { allowed: true }
  | { allowed: false; reason: 'ALREADY_CANCELLED' | 'NOT_CANCELLABLE' | 'DEADLINE_PASSED' };

/**
 * Reglas de cancelación (RF-RES-005). El plazo sale de `booking.cancellation_deadline_minutes`,
 * que sigue pendiente de definir (CLAUDE.md §4.2). Con `null` (provisional, decidido en la Fase 7):
 * - el cliente cancela una PENDING_PAYMENT siempre y una CONFIRMED hasta que empiece;
 * - con un número N, la CONFIRMED solo hasta N minutos antes del inicio.
 * La barbería (OWNER o MANAGER, con motivo) cancela hasta que empiece; el plazo no la limita.
 * Nada aquí decide devoluciones: esa política también está pendiente.
 */
export function cancellationDecision(input: {
  status: BookingStatus;
  startAt: number;
  now: number;
  by: 'CLIENT' | 'BARBERSHOP';
  deadlineMinutes: number | null;
}): CancelDecision {
  const { status, startAt, now, by, deadlineMinutes } = input;
  if (status === 'CANCELLED') return { allowed: false, reason: 'ALREADY_CANCELLED' };
  if (status !== 'PENDING_PAYMENT' && status !== 'CONFIRMED') {
    return { allowed: false, reason: 'NOT_CANCELLABLE' };
  }
  if (by === 'CLIENT' && status === 'PENDING_PAYMENT') return { allowed: true };
  const limit =
    by === 'CLIENT' && deadlineMinutes !== null ? startAt - deadlineMinutes * 60_000 : startAt;
  return now < limit ? { allowed: true } : { allowed: false, reason: 'DEADLINE_PASSED' };
}

/** `null` o un entero ≥ 0; cualquier otro valor se trata como no definido. */
export function parseDeadline(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
