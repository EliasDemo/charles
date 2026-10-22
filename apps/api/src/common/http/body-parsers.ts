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

/**
 * Rutas cuyo cuerpo se conserva sin procesar (webhooks y resultado reenviado por la app): la
 * firma se calcula sobre el texto exacto.
 */
export const RAW_BODY_PATH =
  /^\/api\/v\d+\/(payments\/webhooks\/[^/?]+|billing\/webhooks\/[^/?]+|bookings\/[^/?]+\/payment\/verify)(\?|$)/;

export type RequestWithRawBody = Request & { rawBody?: Buffer };

/** Guarda el cuerpo original (solo en webhooks de pagos; en el resto no hace falta). */
function keepRawBody(req: RequestWithRawBody, _res: unknown, buffer: Buffer): void {
  if (RAW_BODY_PATH.test(req.originalUrl ?? req.url)) req.rawBody = Buffer.from(buffer);
}

export function bodyParsers(limit: string): RequestHandler[] {
  return [
    wrap(json({ limit, verify: keepRawBody })),
    wrap(urlencoded({ limit, extended: false, verify: keepRawBody })),
  ];
}
