import { auditChanges } from './audit-diff';

describe('auditChanges (CLAUDE.md §4.1)', () => {
  const before = {
    priceAmount: 2500,
    durationMinutes: 30,
    phone: '+51 900 000 001',
    name: 'Corte',
  };

  it('datos no personales: valor anterior y nuevo', () => {
    expect(auditChanges(before, { priceAmount: 3000, durationMinutes: 30 })).toEqual({
      values: { priceAmount: { from: 2500, to: 3000 } },
    });
  });

  it('datos personales: solo el nombre del campo, nunca el valor', () => {
    const changes = auditChanges(before, { phone: '+51 999 999 999', priceAmount: 2600 }, [
      'phone',
    ]);
    expect(changes).toEqual({
      values: { priceAmount: { from: 2500, to: 2600 } },
      personalFields: ['phone'],
    });
    expect(JSON.stringify(changes)).not.toMatch(/900|999/);
  });

  it('ignora campos no enviados y valores sin cambio; null si no hay cambios', () => {
    expect(auditChanges(before, { priceAmount: undefined, name: 'Corte' })).toBeNull();
  });

  it('registra el paso a null y normaliza fechas', () => {
    const date = new Date('2030-01-01T00:00:00.000Z');
    expect(auditChanges<{ reopen: Date | null }>({ reopen: date }, { reopen: null })).toEqual({
      values: { reopen: { from: '2030-01-01T00:00:00.000Z', to: null } },
    });
  });
});
