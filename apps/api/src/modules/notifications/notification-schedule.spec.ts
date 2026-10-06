import { DateTime } from 'luxon';
import {
  inQuietHours,
  lastAllowedAt,
  nextAllowedAt,
  normalizeReminderHours,
  reminderDue,
  reminderSendAt,
} from './notification-schedule';

const LIMA = 'America/Lima';
const quiet = { start: '22:00', end: '08:00', timezone: LIMA };
const at = (iso: string) => DateTime.fromISO(iso, { zone: LIMA }).toMillis();
const HOUR = 3_600_000;

describe('RF-NOT Fase 10: horario de las notificaciones', () => {
  it.each([
    ['2030-01-07T21:59', false],
    ['2030-01-07T22:00', true],
    ['2030-01-07T23:30', true],
    ['2030-01-08T03:00', true],
    ['2030-01-08T07:59', true],
    ['2030-01-08T08:00', false],
    ['2030-01-08T12:00', false],
  ])('silencio 22:00–08:00 en Lima: %s → %s', (iso, expected) => {
    expect(inQuietHours(at(iso), quiet)).toBe(expected);
  });

  it('un horario que no cruza la medianoche, y uno vacío', () => {
    const day = { start: '13:00', end: '15:00', timezone: LIMA };
    expect(inQuietHours(at('2030-01-07T14:00'), day)).toBe(true);
    expect(inQuietHours(at('2030-01-07T15:00'), day)).toBe(false);
    expect(inQuietHours(at('2030-01-07T23:00'), { ...quiet, end: '22:00' })).toBe(false);
  });

  it('la zona es la de la barbería, no la del servidor', () => {
    // 23:00 UTC = 18:00 en Lima: en silencio para UTC, no para la barbería.
    expect(inQuietHours(Date.UTC(2030, 0, 7, 23), quiet)).toBe(false);
    expect(inQuietHours(Date.UTC(2030, 0, 7, 23), { ...quiet, timezone: 'UTC' })).toBe(true);
  });

  it('un push no urgente se aplaza hasta las 08:00', () => {
    expect(nextAllowedAt(at('2030-01-07T23:00'), quiet)).toBe(at('2030-01-08T08:00'));
    expect(nextAllowedAt(at('2030-01-08T02:00'), quiet)).toBe(at('2030-01-08T08:00'));
    expect(nextAllowedAt(at('2030-01-08T10:00'), quiet)).toBe(at('2030-01-08T10:00'));
  });

  it('un recordatorio en silencio se adelanta al último momento permitido (21:59)', () => {
    expect(lastAllowedAt(at('2030-01-08T06:00'), quiet)).toBe(at('2030-01-07T21:59'));
    expect(lastAllowedAt(at('2030-01-07T23:00'), quiet)).toBe(at('2030-01-07T21:59'));
    // Cita a las 09:00: el de 2 h (07:00) se adelanta a las 21:59 del día anterior.
    expect(reminderSendAt(at('2030-01-08T09:00'), 2, quiet)).toBe(at('2030-01-07T21:59'));
    // El de 24 h de una cita a las 15:00 no cambia.
    expect(reminderSendAt(at('2030-01-08T15:00'), 24, quiet)).toBe(at('2030-01-07T15:00'));
  });

  describe('cuándo toca un recordatorio', () => {
    const startAt = at('2030-01-08T15:00');
    const base = { startAt, confirmedAt: at('2030-01-01T10:00'), hours: 2, quiet };
    it('desde su hora y hasta el inicio', () => {
      expect(reminderDue({ ...base, now: startAt - 2 * HOUR - 1 })).toBe(false);
      expect(reminderDue({ ...base, now: startAt - 2 * HOUR })).toBe(true);
      expect(reminderDue({ ...base, now: startAt - 1 })).toBe(true);
    });
    it('nunca de una reserva que ya empezó', () => {
      expect(reminderDue({ ...base, now: startAt })).toBe(false);
    });
    it('no si su momento pasó antes de confirmarse la reserva', () => {
      expect(
        reminderDue({ ...base, hours: 24, confirmedAt: startAt - 3 * HOUR, now: startAt - HOUR }),
      ).toBe(false);
    });
  });

  it('horas de recordatorio: enteros 1–168, sin repetir, de mayor a menor', () => {
    expect(normalizeReminderHours([2, 24, 2])).toEqual([24, 2]);
    expect(normalizeReminderHours([])).toEqual([]);
    expect(normalizeReminderHours([0])).toBeNull();
    expect(normalizeReminderHours([200])).toBeNull();
    expect(normalizeReminderHours('24')).toBeNull();
    expect(normalizeReminderHours([1, 2, 3, 4, 5])).toBeNull();
  });
});
