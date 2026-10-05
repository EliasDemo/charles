import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerDecorator, type ValidationOptions } from 'class-validator';

/** CLAUDE.md §4.1: 10 a 128 caracteres, sin reglas de composición (criterio NIST). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

let commonPasswords: ReadonlySet<string> | undefined;

/** Lista local de contraseñas comunes (sin servicios externos en el MVP). */
function loadCommonPasswords(): ReadonlySet<string> {
  commonPasswords ??= new Set(
    readFileSync(join(__dirname, 'common-passwords.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
  return commonPasswords;
}

export function isCommonPassword(password: string): boolean {
  return loadCommonPasswords().has(password.toLowerCase());
}

/** Rechaza contraseñas de la lista local de contraseñas comunes (regla `notCommonPassword`). */
export function IsNotCommonPassword(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'notCommonPassword',
      target: target.constructor,
      propertyName: propertyName.toString(),
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && !isCommonPassword(value),
      },
    });
  };
}
