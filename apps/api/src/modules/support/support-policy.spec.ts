import {
  canStaffMoveTicket,
  closingNeedsReason,
  STAFF_TICKET_TRANSITIONS,
  userReplyDecision,
} from './support-policy';

describe('RF-SOP-002 reglas de tickets', () => {
  it('CLOSED es final', () => {
    expect(STAFF_TICKET_TRANSITIONS.CLOSED).toEqual([]);
  });

  it.each([
    ['OPEN', 'IN_PROGRESS', true],
    ['OPEN', 'RESOLVED', false],
    ['IN_PROGRESS', 'RESOLVED', true],
    ['RESOLVED', 'IN_PROGRESS', true],
    ['RESOLVED', 'CLOSED', true],
    ['CLOSED', 'OPEN', false],
    ['IN_PROGRESS', 'OPEN', false],
  ] as const)('%s → %s: %s', (from, to, allowed) => {
    expect(canStaffMoveTicket(from, to)).toBe(allowed);
  });

  it('cerrar sin resolver exige motivo', () => {
    expect(closingNeedsReason('OPEN', 'CLOSED')).toBe(true);
    expect(closingNeedsReason('IN_PROGRESS', 'CLOSED')).toBe(true);
    expect(closingNeedsReason('RESOLVED', 'CLOSED')).toBe(false);
    expect(closingNeedsReason('OPEN', 'IN_PROGRESS')).toBe(false);
  });

  describe('respuesta del usuario', () => {
    const resolvedAt = new Date('2030-01-07T12:00:00Z');
    const day = 24 * 3600_000;
    it('abierto: se agrega', () => {
      expect(userReplyDecision('OPEN', null, 0, 7)).toBe('APPEND');
      expect(userReplyDecision('IN_PROGRESS', null, 0, 7)).toBe('APPEND');
    });
    it('resuelto: reabre dentro del plazo (inclusivo), después no', () => {
      expect(userReplyDecision('RESOLVED', resolvedAt, resolvedAt.getTime() + 7 * day, 7)).toBe(
        'REOPEN',
      );
      expect(userReplyDecision('RESOLVED', resolvedAt, resolvedAt.getTime() + 7 * day + 1, 7)).toBe(
        'REJECT',
      );
    });
    it('cerrado o resuelto sin fecha: no', () => {
      expect(userReplyDecision('CLOSED', resolvedAt, 0, 7)).toBe('REJECT');
      expect(userReplyDecision('RESOLVED', null, 0, 7)).toBe('REJECT');
    });
  });
});
