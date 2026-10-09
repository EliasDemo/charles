import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import type { AuthenticatedRequest } from './auth-user';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ALLOW_RESTRICTED_SESSION_KEY } from './restricted-session.decorator';
import { SessionRevocationStore } from './session-revocation.store';
import { TokenService } from './token.service';

const unauthorized = (): AppException =>
  new AppException(
    ErrorCode.UNAUTHORIZED,
    'Tu sesión no es válida o expiró. Inicia sesión nuevamente.',
    HttpStatus.UNAUTHORIZED,
  );

/** Deniega por defecto: todo endpoint exige token salvo `@Public()` (CLAUDE.md §6.4). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly revocations: SessionRevocationStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (isPublic) {
      // Sesión opcional: si llega un token válido, el endpoint público puede personalizar la
      // respuesta (p. ej. isFavorite). Un token inválido, revocado o restringido no es un error:
      // la petición sigue como anónima.
      await this.attachOptionalUser(request);
      return true;
    }

    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthorized();

    const user = this.tokens.verifyAccessToken(token);
    if (!user) throw unauthorized();

    let revoked: boolean;
    try {
      revoked = await this.revocations.isRevoked(user.sessionId);
    } catch (error) {
      // Sin Redis no se puede comprobar la revocación: se falla de forma cerrada.
      this.logger.error({ err: error }, 'No se pudo comprobar la revocación de la sesión');
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'El servicio no está disponible temporalmente.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (revoked) throw unauthorized();

    if (user.restricted) {
      const allowed = this.reflector.getAllAndOverride<string[] | undefined>(
        ALLOW_RESTRICTED_SESSION_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (!allowed?.includes(user.restricted)) {
        throw user.restricted === 'deletion'
          ? new AppException(
              ErrorCode.ACCOUNT_PENDING_DELETION,
              'Tu cuenta está pendiente de eliminación. Solo puedes consultarla o cancelarla.',
              HttpStatus.FORBIDDEN,
            )
          : new AppException(
              ErrorCode.ACCOUNT_DISABLED,
              'Tu cuenta está deshabilitada. Solo puedes comunicarte con soporte.',
              HttpStatus.FORBIDDEN,
            );
      }
    }

    request.user = user;
    return true;
  }

  private async attachOptionalUser(request: AuthenticatedRequest): Promise<void> {
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return;
    const user = this.tokens.verifyAccessToken(token);
    if (!user || user.restricted) return;
    try {
      if (await this.revocations.isRevoked(user.sessionId)) return;
    } catch {
      return; // sin Redis no se personaliza, pero el endpoint público responde igual
    }
    request.user = user;
  }
}
