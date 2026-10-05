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
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
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

    request.user = user;
    return true;
  }
}
