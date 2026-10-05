import { HttpStatus } from '@nestjs/common';
import { type ValidationError } from 'class-validator';
import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

export interface ValidationErrorDetail {
  field: string;
  /** Nombres de las reglas incumplidas (por ejemplo `isEmail`, `whitelistValidation`). */
  constraints: string[];
}

function flatten(errors: ValidationError[], parent = ''): ValidationErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own: ValidationErrorDetail[] = error.constraints
      ? [{ field, constraints: Object.keys(error.constraints) }]
      : [];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

/**
 * Convierte los errores de `class-validator` en un `AppException` uniforme.
 * No devuelve los valores recibidos, solo el campo y la regla incumplida.
 */
export function validationExceptionFactory(errors: ValidationError[]): AppException {
  return new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    flatten(errors),
  );
}
