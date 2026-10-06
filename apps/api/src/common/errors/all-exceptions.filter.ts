import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from './app.exception';
import { dbErrorInfo } from './db-error';
import { defaultErrorFor } from './error-codes';
import { ErrorResponseDto } from './error-response.dto';

export function requestIdOf(req: Request): string {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
}

/**
 * Convierte cualquier excepción en la respuesta uniforme `{ code, message, details, requestId }`.
 * Nunca expone mensajes internos, trazas ni datos recibidos.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const { status, body } = toErrorResponse(exception, requestIdOf(req));

    if (status >= 500) {
      const db = dbErrorInfo(exception);
      // Errores de base de datos: solo los códigos (Prisma, PostgreSQL y restricción). El mensaje
      // de Prisma puede incluir valores de la consulta (datos personales): no se registra.
      this.logger.error(
        db
          ? {
              db,
              errorName: exception instanceof Error ? exception.name : typeof exception,
              code: body.code,
              requestId: body.requestId,
              route: `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? ''}`,
            }
          : { err: exception, code: body.code, requestId: body.requestId },
        'Error no controlado',
      );
    }

    if (res.headersSent) return;
    res.status(status).json(body);
  }
}

export function toErrorResponse(
  exception: unknown,
  requestId: string,
): { status: number; body: ErrorResponseDto } {
  if (exception instanceof AppException) {
    return {
      status: exception.getStatus(),
      body: {
        code: exception.code,
        message: exception.userMessage,
        details: exception.details,
        requestId,
      },
    };
  }

  const status =
    exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  const { code, message } = defaultErrorFor(status);
  return { status, body: { code, message, details: [], requestId } };
}
