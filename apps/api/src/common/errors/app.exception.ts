import { HttpException, type HttpStatus } from '@nestjs/common';
import { type ErrorCode } from './error-codes';

/**
 * Error de negocio con código estable (inglés) y mensaje para el usuario final (español).
 * El filtro global lo convierte en `{ code, message, details, requestId }`.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    readonly userMessage: string,
    status: HttpStatus,
    readonly details: unknown[] = [],
  ) {
    super(userMessage, status);
  }
}
