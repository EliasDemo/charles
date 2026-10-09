import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { AllowRestrictedSession } from '../../common/auth/restricted-session.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { clientIpOf } from '../../common/throttling/client-ip-throttler.guard';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { AccountDeletionService } from './account-deletion.service';
import {
  AccountDeletionPreviewDto,
  AccountDeletionStatusDto,
  RequestAccountDeletionDto,
} from './dto/account-deletion.dto';

/**
 * Eliminación de cuenta. Una cuenta deshabilitada la pide desde su sesión restringida
 * (`support`); una pendiente de eliminación solo consulta o cancela (`deletion`).
 */
@ApiTags('account')
@ApiBearerAuth()
@Controller('me/account/deletion')
export class AccountController {
  constructor(private readonly deletion: AccountDeletionService) {}

  @Get('preview')
  @AllowRestrictedSession('support')
  @ApiOperation({
    summary: 'Vista previa: reservas que se cancelarán (y cuánto se devuelve) y bloqueos',
  })
  @ApiOkResponse({ type: AccountDeletionPreviewDto })
  preview(@CurrentUser() user: AuthUser): Promise<AccountDeletionPreviewDto> {
    return this.deletion.preview(user.id);
  }

  @Get()
  @AllowRestrictedSession('support', 'deletion')
  @ApiOperation({ summary: 'Estado de la eliminación de la cuenta' })
  @ApiOkResponse({ type: AccountDeletionStatusDto })
  status(@CurrentUser() user: AuthUser): Promise<AccountDeletionStatusDto> {
    return this.deletion.status(user.id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth')
  @AllowRestrictedSession('support')
  @ApiOperation({
    summary: 'Solicitar la eliminación de la cuenta (con la contraseña)',
    description:
      'Cancela al instante sus reservas activas como cancelación del cliente, cierra sus tickets ' +
      'y todas sus sesiones. La eliminación se ejecuta tras account_deletion.grace_days (30); ' +
      'hasta entonces se puede cancelar desde el acceso limitado (POST /auth/support-access). ' +
      '409 DELETION_BLOCKED con los bloqueos en details.',
  })
  @ApiOkResponse({ type: AccountDeletionStatusDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  request(
    @CurrentUser() user: AuthUser,
    @Body() dto: RequestAccountDeletionDto,
    @Req() req: Request,
  ): Promise<AccountDeletionStatusDto> {
    return this.deletion.request(user.id, user.sessionId, dto.password, clientIpOf(req));
  }

  @Delete()
  @AllowRestrictedSession('deletion')
  @ApiOperation({
    summary: 'Cancelar la eliminación (dentro del plazo); las reservas canceladas no se restauran',
  })
  @ApiOkResponse({ type: AccountDeletionStatusDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  cancel(@CurrentUser() user: AuthUser, @Req() req: Request): Promise<AccountDeletionStatusDto> {
    return this.deletion.cancel(user.id, clientIpOf(req));
  }
}
