import { randomBytes } from 'node:crypto';
import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { cookieOf, isCsrfValid, WEB_COOKIES } from '../../common/auth/web-session';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { clientIpOf } from '../../common/throttling/client-ip-throttler.guard';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { AuthService } from './auth.service';
import { type AuthTokensDto, LoginDto, SessionUserDto } from './dto/auth.dto';
import { MfaCodeDto, MfaVerifyDto } from './mfa/mfa.dto';
import { MfaService } from './mfa/mfa.service';

/** Sesión web: lo mismo que los tokens, pero sin ellos (viajan en cookies HttpOnly). */
export class WebSessionDto {
  @ApiProperty({ type: SessionUserDto })
  user!: SessionUserDto;

  @ApiProperty({ description: 'Sesión de personal (con segundo factor): puede entrar a /admin.' })
  mfa!: boolean;

  @ApiProperty()
  accessTokenExpiresAt!: Date;

  @ApiProperty({
    description: 'Fin de la sesión. Personal: 30 min sin actividad y 12 h como máximo.',
  })
  refreshTokenExpiresAt!: Date;

  @ApiProperty({
    description:
      'Token CSRF (también en la cookie legible `charles_csrf`): enviarlo en la cabecera ' +
      '`X-CSRF-Token` en toda petición que cambie datos.',
  })
  csrfToken!: string;
}

export class WebMfaEnabledDto {
  @ApiProperty({ type: [String], description: 'Se muestran una sola vez: hay que guardarlos.' })
  recoveryCodes!: string[];

  @ApiProperty({ type: WebSessionDto })
  session!: WebSessionDto;
}

const expired = (): AppException =>
  new AppException(
    ErrorCode.INVALID_REFRESH_TOKEN,
    'Tu sesión expiró. Inicia sesión nuevamente.',
    HttpStatus.UNAUTHORIZED,
  );

/**
 * Sesión de la web (charlesweb), con cookies `HttpOnly` y CSRF por doble envío. Mismas reglas que
 * la app (bloqueo por intentos, rotación del token de renovación); los tokens nunca llegan a
 * JavaScript. La app móvil sigue usando `/auth/login` con `Authorization: Bearer`.
 */
@ApiTags('auth')
@RateLimit('auth')
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@Controller('auth/web')
export class WebAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Web: iniciar sesión (tokens en cookies)',
    description:
      'El personal debe completar después el segundo factor (/auth/web/mfa/verify) para /admin.',
  })
  @ApiOkResponse({ type: WebSessionDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebSessionDto> {
    const tokens = await this.auth.login(
      { ...dto, deviceName: dto.deviceName ?? 'Web' },
      { ip: clientIpOf(req), userAgent: req.headers['user-agent'] },
    );
    return this.setSession(res, tokens, false);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Web: renovar la sesión (lee la cookie; exige X-CSRF-Token)',
  })
  @ApiOkResponse({ type: WebSessionDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebSessionDto> {
    this.assertCsrf(req);
    const refreshToken = cookieOf(req, WEB_COOKIES.refresh);
    if (!refreshToken) throw expired();
    try {
      const tokens = await this.auth.refresh(refreshToken, {
        ip: clientIpOf(req),
        userAgent: req.headers['user-agent'],
      });
      return this.setSession(res, tokens, this.isMfa(tokens));
    } catch (error) {
      this.clear(res);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Web: cerrar sesión (revoca y borra las cookies)' })
  @ApiNoContentResponse()
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(user, false, {
      ip: clientIpOf(req),
      userAgent: req.headers['user-agent'],
    });
    this.clear(res);
  }

  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Web, personal: activar el segundo factor (tras /auth/mfa/setup) y entrar',
  })
  @ApiOkResponse({ type: WebMfaEnabledDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async enableMfa(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebMfaEnabledDto> {
    const result = await this.mfa.enable(user, dto.code, clientIpOf(req));
    await this.auth.logout(user, false, { ip: clientIpOf(req), userAgent: undefined });
    return {
      recoveryCodes: result.recoveryCodes,
      session: this.setSession(res, result.tokens, true),
    };
  }

  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Web, personal: segundo factor para entrar a la administración',
    description: 'Reemplaza la sesión de la web por una de personal (12 h máx., 30 min inactiva).',
  })
  @ApiOkResponse({ type: WebSessionDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async verifyMfa(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebSessionDto> {
    const tokens = await this.mfa.verify(user, dto, clientIpOf(req));
    // La sesión sin segundo factor de la web ya no hace falta.
    await this.auth.logout(user, false, { ip: clientIpOf(req), userAgent: undefined });
    return this.setSession(res, tokens, true);
  }

  // ───────────── Cookies ─────────────

  private base(): CookieOptions {
    return {
      secure: this.config.web.cookieSecure,
      sameSite: 'lax',
      ...(this.config.web.cookieDomain ? { domain: this.config.web.cookieDomain } : {}),
    };
  }

  private setSession(res: Response, tokens: AuthTokensDto, mfa: boolean): WebSessionDto {
    const now = Date.now();
    const csrfToken = randomBytes(24).toString('base64url');
    res.cookie(WEB_COOKIES.access, tokens.accessToken, {
      ...this.base(),
      httpOnly: true,
      path: '/api',
      maxAge: Math.max(tokens.accessTokenExpiresAt.getTime() - now, 0),
    });
    res.cookie(WEB_COOKIES.refresh, tokens.refreshToken, {
      ...this.base(),
      httpOnly: true,
      path: '/api/v1/auth/web',
      maxAge: Math.max(tokens.refreshTokenExpiresAt.getTime() - now, 0),
    });
    res.cookie(WEB_COOKIES.csrf, csrfToken, {
      ...this.base(),
      httpOnly: false,
      path: '/',
      maxAge: Math.max(tokens.refreshTokenExpiresAt.getTime() - now, 0),
    });
    return {
      user: tokens.user,
      mfa,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      csrfToken,
    };
  }

  private clear(res: Response): void {
    res.clearCookie(WEB_COOKIES.access, { ...this.base(), path: '/api' });
    res.clearCookie(WEB_COOKIES.refresh, { ...this.base(), path: '/api/v1/auth/web' });
    res.clearCookie(WEB_COOKIES.csrf, { ...this.base(), path: '/' });
  }

  private assertCsrf(req: Request): void {
    if (!isCsrfValid(req)) {
      throw new AppException(
        ErrorCode.CSRF_INVALID,
        'La solicitud no es válida. Recarga la página e inténtalo de nuevo.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** La sesión renovada conserva su tipo (lo indica el token de acceso). */
  private isMfa(tokens: AuthTokensDto): boolean {
    const [, payload] = tokens.accessToken.split('.');
    try {
      return (
        (JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { amr?: string })
          .amr === 'mfa'
      );
    } catch {
      return false;
    }
  }
}
