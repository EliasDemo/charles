import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterDto } from '../dto/auth.dto';
import { isCommonPassword } from './password-policy';

function passwordErrors(password: unknown): string[] {
  const dto = plainToInstance(RegisterDto, {
    fullName: 'Ana Pérez',
    email: 'ana@example.com',
    password,
    acceptTerms: true,
    declaresAdult: true,
    termsVersion: 'v1',
  });
  return validateSync(dto).flatMap((e) =>
    e.property === 'password' ? Object.keys(e.constraints ?? {}) : [],
  );
}

describe('Política de contraseñas (CLAUDE.md §4.1)', () => {
  it('acepta de 10 a 128 caracteres sin reglas de composición', () => {
    expect(passwordErrors('solo letras minusculas')).toEqual([]);
    expect(passwordErrors('a'.repeat(9) + 'z')).toEqual([]);
    expect(passwordErrors('ñ'.repeat(128))).toEqual([]);
  });

  it('rechaza menos de 10 o más de 128 caracteres', () => {
    expect(passwordErrors('123456789')).toContain('isLength');
    expect(passwordErrors('x'.repeat(129))).toContain('isLength');
  });

  it.each(['1234567890', 'qwertyuiop', 'Password123', 'PASSWORD123'])(
    'rechaza la contraseña común %p (sin distinguir mayúsculas)',
    (password) => {
      expect(isCommonPassword(password)).toBe(true);
      expect(passwordErrors(password)).toContain('notCommonPassword');
    },
  );

  it('no rechaza una contraseña poco común', () => {
    expect(isCommonPassword('tijera-azul-barberia-2026')).toBe(false);
  });

  it('rechaza valores que no son texto', () => {
    expect(passwordErrors(1234567890)).toContain('isString');
  });
});
