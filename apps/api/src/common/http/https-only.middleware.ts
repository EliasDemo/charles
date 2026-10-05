import { HttpStatus, Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/env.validation';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * En producción rechaza toda petición que no llegue por HTTPS (CLAUDE.md §6.1).
 * `req.secure` considera `X-Forwarded-Proto` solo si viene de un proxy de confianza (TRUST_PROXY).
 */
@Injectable()
export class HttpsOnlyMiddleware implements NestMiddleware {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    if (this.config.isProduction && !req.secure) {
      throw new AppException(
        ErrorCode.HTTPS_REQUIRED,
        'Se requiere una conexión segura (HTTPS).',
        HttpStatus.FORBIDDEN,
      );
    }
    next();
  }
}
