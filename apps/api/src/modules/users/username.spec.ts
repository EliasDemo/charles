import { normalizeUsername, usernameProblem } from './username';

describe('Nombre de usuario', () => {
  it.each(['ana', 'carlos_fade', 'ana.perez23', 'a1b', 'x'.repeat(20), 'el.barbero_9'])(
    'acepta %s',
    (u) => expect(usernameProblem(u)).toBeNull(),
  );

  it.each([
    'ab', // muy corto
    'x'.repeat(21), // muy largo
    'Ana', // mayúsculas (se normaliza antes)
    '.ana',
    'ana_',
    'ana..perez',
    'ana._perez',
    'ana perez',
    'ana-perez',
    'ana@mail.com', // parece correo
    'ñandu',
  ])('rechaza %s por formato', (u) => expect(usernameProblem(u)).toBe('INVALID'));

  it.each(['charles', 'admin', 'soporte', 'charles_oficial', 'superadmin', 'el.soporte'])(
    'rechaza %s por reservado',
    (u) => expect(usernameProblem(u)).toBe('RESERVED'),
  );

  it('normaliza espacios y mayúsculas', () => {
    expect(normalizeUsername('  Carlos_Fade ')).toBe('carlos_fade');
  });
});
