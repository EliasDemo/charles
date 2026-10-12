import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../../common/auth/auth-user';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto';
import { clientIpOf } from '../../../common/throttling/client-ip-throttler.guard';
import { RateLimit } from '../../../common/throttling/rate-limit.decorator';
import { AuthTokensDto } from '../dto/auth.dto';
import {
  MfaCodeDto,
  MfaEnabledDto,
  MfaRecoveryCodesDto,
  MfaSetupDto,
  MfaStatusDto,
  MfaVerifyDto,
} from './mfa.dto';
import { MfaService } from './mfa.service';

/**
 * Verificación en dos pasos del personal (SUPPORT y ADMIN). El login no cambia: para entrar a
 * `/admin` hace falta una **sesión de personal**, que se obtiene aquí con un código TOTP.
 */
@ApiTags('auth')
@ApiBearerAuth()
@RateLimit('auth')
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  @ApiOperation({ summary: 'Estado de la verificación en dos pasos de mi cuenta' })
  @ApiOkResponse({ type: MfaStatusDto })
  status(@CurrentUser() user: AuthUser): Promise<MfaStatusDto> {
    return this.mfa.status(user);
  }

  @Post('setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Personal: generar el código QR para activar la verificación en dos pasos',
    description: 'Escanéalo con Google Authenticator (o similar) y confirma con /auth/mfa/enable.',
  })
  @ApiOkResponse({ type: MfaSetupDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  setup(@CurrentUser() user: AuthUser): Promise<MfaSetupDto> {
    return this.mfa.setup(user);
  }

  @Post('enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Personal: activar con el primer código de la app',
    description:
      'Devuelve los códigos de recuperación (se muestran una sola vez) y una sesión de personal.',
  })
  @ApiOkResponse({ type: MfaEnabledDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  enable(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
  ): Promise<MfaEnabledDto> {
    return this.mfa.enable(user, dto.code, clientIpOf(req));
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Personal: segundo factor para entrar a la administración',
    description:
      'Con el código de la app (o uno de recuperación) devuelve una sesión de personal: dura ' +
      '12 h como máximo y se cierra tras 30 min sin renovarse. 5 códigos incorrectos bloquean ' +
      '15 min (MFA_LOCKED).',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  verify(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaVerifyDto,
    @Req() req: Request,
  ): Promise<AuthTokensDto> {
    return this.mfa.verify(user, dto, clientIpOf(req));
  }

  @Post('recovery-codes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Personal: códigos de recuperación nuevos (invalida los anteriores)' })
  @ApiOkResponse({ type: MfaRecoveryCodesDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  async recoveryCodes(
    @CurrentUser() user: AuthUser,
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
  ): Promise<MfaRecoveryCodesDto> {
    return {
      recoveryCodes: await this.mfa.regenerateRecoveryCodes(user, dto.code, clientIpOf(req)),
    };
  }
}
