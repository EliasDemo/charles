import { SEED_SETTINGS } from '../../../prisma/seed/seed';
import { suspensionCancels } from './admin-barbershops.service';
import { schemaViolation, SETTING_RULES } from './admin-settings';

describe('RF-OPE Fase 12: reglas puras de operación', () => {
  describe('esquemas de ajustes', () => {
    it('toda clave sembrada tiene regla (editable con esquema, o de solo lectura)', () => {
      const missing = SEED_SETTINGS.map((s) => s.key).filter((key) => !SETTING_RULES[key]);
      expect(missing).toEqual([]);
      for (const [key, rule] of Object.entries(SETTING_RULES)) {
        expect([key, !!rule.schema !== !!rule.readOnly]).toEqual([key, true]);
      }
    });

    it('las claves de seguridad y de pagos sensibles son de solo lectura', () => {
      for (const key of [
        'auth.lockout.account_max_failures',
        'auth.lockout.ip_max_failures',
        'payments.provider',
        'payments.webhook_rate_limit_per_minute',
        'payments.commission_policy',
      ]) {
        expect(SETTING_RULES[key]?.readOnly).toBeTruthy();
      }
    });

    it('los valores sembrados cumplen su propio esquema', () => {
      for (const setting of SEED_SETTINGS) {
        const schema = SETTING_RULES[setting.key]?.schema;
        if (schema)
          expect([setting.key, schemaViolation(schema, setting.value)]).toEqual([
            setting.key,
            null,
          ]);
      }
    });

    it('enteros: rango, entero y múltiplo', () => {
      const schema = { type: 'integer' as const, min: 5, max: 60, multipleOf: 5 };
      expect(schemaViolation(schema, 15)).toBeNull();
      expect(schemaViolation(schema, 0)).toMatch(/entre 5 y 60/);
      expect(schemaViolation(schema, 65)).toMatch(/entre 5 y 60/);
      expect(schemaViolation(schema, 12)).toMatch(/múltiplo de 5/);
      expect(schemaViolation(schema, 15.5)).toMatch(/entero/);
      expect(schemaViolation(schema, '15')).toMatch(/entero/);
      expect(schemaViolation({ type: 'integer', min: 0, max: 100 }, 101)).toMatch(/entre 0 y 100/);
    });

    it('booleanos y texto', () => {
      expect(schemaViolation({ type: 'boolean' }, true)).toBeNull();
      expect(schemaViolation({ type: 'boolean' }, 'true')).toMatch(/verdadero o falso/);
      const text = { type: 'string' as const, minLength: 1, maxLength: 5, pattern: /^[a-z]+$/ };
      expect(schemaViolation(text, 'abc')).toBeNull();
      expect(schemaViolation(text, '')).toMatch(/entre 1 y 5/);
      expect(schemaViolation(text, 'abcdef')).toMatch(/entre 1 y 5/);
      expect(schemaViolation(text, 'ab1')).toMatch(/formato/);
      expect(schemaViolation(text, 3)).toMatch(/texto/);
    });
  });

  describe('suspensión: qué reservas se cancelan', () => {
    const now = Date.UTC(2030, 0, 7, 12);
    const hour = 3600_000;
    it('las pendientes de pago se cancelan siempre', () => {
      for (const mode of ['KEEP_UPCOMING', 'CANCEL_ALL', 'KEEP_ALL'] as const) {
        expect(
          suspensionCancels({ status: 'PENDING_PAYMENT', startAt: now + hour }, mode, now, 48),
        ).toBe(true);
      }
    });
    it('por defecto se mantienen las próximas 48 h (inclusivo) y se cancelan las demás', () => {
      const at = (h: number) => ({ status: 'CONFIRMED' as const, startAt: now + h * hour });
      expect(suspensionCancels(at(1), 'KEEP_UPCOMING', now, 48)).toBe(false);
      expect(suspensionCancels(at(48), 'KEEP_UPCOMING', now, 48)).toBe(false);
      expect(suspensionCancels(at(49), 'KEEP_UPCOMING', now, 48)).toBe(true);
    });
    it('CANCEL_ALL y KEEP_ALL; nunca las que ya empezaron ni las de estado final', () => {
      const future = { status: 'CONFIRMED' as const, startAt: now + hour };
      expect(suspensionCancels(future, 'CANCEL_ALL', now, 48)).toBe(true);
      expect(suspensionCancels(future, 'KEEP_ALL', now, 48)).toBe(false);
      expect(
        suspensionCancels({ status: 'CONFIRMED', startAt: now - hour }, 'CANCEL_ALL', now, 48),
      ).toBe(false);
      expect(
        suspensionCancels({ status: 'ATTENDED', startAt: now + hour }, 'CANCEL_ALL', now, 48),
      ).toBe(false);
    });
  });
});
