import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/auth-user';

/**
 * Para endpoints públicos cuya respuesta depende de quién consulta (p. ej. `isFavorite`):
 * - con sesión: `Cache-Control: private, no-store` (ninguna caché la guarda);
 * - sin sesión: `Cache-Control: no-cache` (se revalida siempre);
 * - siempre `Vary: Authorization`, para que una caché nunca mezcle respuestas de cuentas
 *   distintas ni sirva la de una cuenta a una petición anónima.
 */
@Injectable()
export class PersonalizedResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();
    response.setHeader('Cache-Control', request.user ? 'private, no-store' : 'no-cache');
    response.vary('Authorization');
    return next.handle();
  }
}
