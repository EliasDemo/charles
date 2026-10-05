import { Body, Controller, Get, HttpStatus, Patch, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { ProfileDto, UpdateProfileDto } from './dto/profile.dto';
import { UsersService } from './users.service';

const sessionInvalid = (): AppException =>
  new AppException(
    ErrorCode.UNAUTHORIZED,
    'Tu sesión no es válida o expiró. Inicia sesión nuevamente.',
    HttpStatus.UNAUTHORIZED,
  );

/** El usuario siempre es el del token: no existe una ruta por ID para consultar a otros. */
@ApiTags('users')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@Controller('users/me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'RF-CLI-001: consultar mi perfil' })
  @ApiOkResponse({ type: ProfileDto })
  async me(@CurrentUser() user: AuthUser): Promise<ProfileDto> {
    const profile = await this.users.getProfile(user.id);
    if (!profile) throw sessionInvalid();
    return profile;
  }

  @Patch()
  @ApiOperation({ summary: 'RF-CLI-002: actualizar nombre, teléfono o preferencias' })
  @ApiOkResponse({ type: ProfileDto })
  async update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProfileDto,
    @Req() req: Request,
  ): Promise<ProfileDto> {
    const profile = await this.users.updateProfile(user.id, dto, req.ip ?? null);
    if (!profile) throw sessionInvalid();
    return profile;
  }
}
