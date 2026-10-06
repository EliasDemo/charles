import type { TicketStatus } from '../../generated/prisma/enums';

/**
 * Reglas puras de tickets de soporte (Fase 12, RF-SOP-001…003). Sin base ni reloj.
 * Recorrido: OPEN → IN_PROGRESS → RESOLVED → CLOSED. Soporte puede cerrar antes (con motivo) y
 * reabrir un RESOLVED; el usuario reabre un RESOLVED respondiendo dentro del plazo.
 */
export const SUPPORT_DEFAULTS = {
  reopenDays: 7,
  autoCloseDays: 7,
  maxOpenTicketsPerUser: 5,
  suspensionKeepHours: 48,
} as const;

export const STAFF_TICKET_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  OPEN: ['IN_PROGRESS', 'CLOSED'],
  IN_PROGRESS: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

export function canStaffMoveTicket(from: TicketStatus, to: TicketStatus): boolean {
  return STAFF_TICKET_TRANSITIONS[from].includes(to);
}

/** Cerrar sin haber resuelto exige motivo (spam, duplicado, sin respuesta). */
export function closingNeedsReason(from: TicketStatus, to: TicketStatus): boolean {
  return to === 'CLOSED' && from !== 'RESOLVED';
}

export type UserReplyDecision = 'APPEND' | 'REOPEN' | 'REJECT';

/** Qué pasa cuando el usuario responde. */
export function userReplyDecision(
  status: TicketStatus,
  resolvedAt: Date | null,
  nowMs: number,
  reopenDays: number,
): UserReplyDecision {
  if (status === 'OPEN' || status === 'IN_PROGRESS') return 'APPEND';
  if (status === 'RESOLVED' && resolvedAt) {
    return nowMs <= resolvedAt.getTime() + reopenDays * 24 * 3600_000 ? 'REOPEN' : 'REJECT';
  }
  return 'REJECT';
}

/** Tickets abiertos (cuentan para el máximo por usuario). */
export const OPEN_TICKET_STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS'];
