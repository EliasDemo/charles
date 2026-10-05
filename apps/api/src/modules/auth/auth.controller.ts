import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { clientIpOf } from '../../common/throttling/client-ip-throttler.guard';
import { AccountRecoveryService } from './account-recovery.service';
import { AuthService, type RequestContext } from './auth.service';
import {
  AcceptedResponseDto,
  AuthTokensDto,
  EmailVerificationConfirmDto,
  LoginDto,
  LogoutDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RefreshDto,
  RegisterDto,
  TermsDto,
} from './dto/auth.dto';

function contextOf(req: Request): RequestContext {
  return { ip: clientIpOf(req), userAgent: req.headers['user-agent'] };
}

@ApiTags('auth')
@RateLimit('auth')
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly recovery: AccountRecoveryService,
  ) {}

  @Public()
  @Get('terms')
  @ApiOperation({ summary: 'Versión vigente de los términos y condiciones' })
  @ApiOkResponse({ type: TermsDto })
  async terms(): Promise<TermsDto> {
    return { version: await this.auth.termsVersion() };
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'RF-AUT-001: registro (respuesta idéntica exista o no el correo, ADR 0003)',
  })
  @ApiAcceptedResponse({ type: AcceptedResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  register(@Body() dto: RegisterDto, @Req() req: Request): Promise<AcceptedResponseDto> {
    return this.auth.register(dto, contextOf(req));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RF-AUT-002: inicio de sesión con correo y contraseña' })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'Cuenta deshabilitada' })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<AuthTokensDto> {
    return this.auth.login(dto, contextOf(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renovar la sesión (rota el token de renovación)' })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<AuthTokensDto> {
    return this.auth.refresh(dto.refreshToken, contextOf(req));
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'RF-AUT-003: cerrar sesión (este dispositivo o todos)' })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  logout(
    @CurrentUser() user: AuthUser,
    @Body() dto: LogoutDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.auth.logout(user, dto.allDevices === true, contextOf(req));
  }

  @Public()
  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'RF-AUT-004: solicitar código (respuesta idéntica exista o no)' })
  @ApiAcceptedResponse({ type: AcceptedResponseDto })
  requestPasswordReset(@Body() dto: PasswordResetRequestDto): Promise<AcceptedResponseDto> {
    return this.recovery.requestPasswordReset(dto.email);
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'RF-AUT-004: nueva contraseña con el código (cierra todas las sesiones)',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  confirmPasswordReset(@Body() dto: PasswordResetConfirmDto, @Req() req: Request): Promise<void> {
    return this.recovery.confirmPasswordReset(dto, contextOf(req));
  }

  @ApiBearerAuth()
  @Post('email-verification/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Enviar un código nuevo de verificación de correo' })
  @ApiAcceptedResponse({ type: AcceptedResponseDto })
  requestEmailVerification(@CurrentUser() user: AuthUser): Promise<AcceptedResponseDto> {
    return this.recovery.requestEmailVerification(user);
  }

  @ApiBearerAuth()
  @Post('email-verification/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Verificar el correo con el código recibido' })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  confirmEmailVerification(
    @CurrentUser() user: AuthUser,
    @Body() dto: EmailVerificationConfirmDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.recovery.confirmEmailVerification(user, dto.code, contextOf(req));
  }
}
