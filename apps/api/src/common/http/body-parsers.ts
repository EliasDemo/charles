import { HttpStatus } from '@nestjs/common';
import {
  json,
  urlencoded,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { AppException } from '../errors/app.exception';
import { defaultErrorFor, ErrorCode } from '../errors/error-codes';

/** Errores de `body-parser` (tienen `type` y `status`). */
interface BodyParserError {
  type?: unknown;
  status?: unknown;
}

/**
 * Traduce un error de `body-parser` a `AppException`. Sin esto, Nest convierte
 * cualquier `SyntaxError` en un `BadRequestException` genérico y se pierde el motivo.
 */
export function bodyParserErrorToAppException(error: unknown): AppException {
  const { type, status } = (error ?? {}) as BodyParserError;
  if (type === 'entity.parse.failed') {
    return new AppException(
      ErrorCode.MALFORMED_JSON,
      'El cuerpo de la solicitud no es un JSON válido.',
      HttpStatus.BAD_REQUEST,
    );
  }
  const httpStatus =
    typeof status === 'number' && status >= 400 && status < 500 ? status : HttpStatus.BAD_REQUEST;
  const { code, message } = defaultErrorFor(httpStatus);
  return new AppException(code, message, httpStatus);
}

function wrap(parser: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) =>
    parser(req, res, (error?: unknown) => {
      next(error ? bodyParserErrorToAppException(error) : undefined);
    });
}

export function bodyParsers(limit: string): RequestHandler[] {
  return [wrap(json({ limit })), wrap(urlencoded({ limit, extended: false }))];
}
