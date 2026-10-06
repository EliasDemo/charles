import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import type { Page } from '../../common/pagination/pagination';
import { DevicesService } from './devices.service';
import {
  DeviceDto,
  DeviceListDto,
  MarkedReadDto,
  type NotificationDto,
  NotificationPageDto,
  NotificationQueryDto,
  RegisterDeviceDto,
  UnreadCountDto,
} from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

const uuid = new ParseUUIDPipe();

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me')
export class NotificationsController {
  constructor(
    private readonly devices: DevicesService,
    private readonly notifications: NotificationsService,
  ) {}

  // ───────────── Dispositivos (RF-NOT-001) ─────────────

  @Put('devices')
  @ApiOperation({
    summary: 'RF-NOT-001: registrar o actualizar el dispositivo para recibir push',
    description:
      'El token de Expo va en el cuerpo (nunca en la URL). Idempotente por token. Queda ligado a ' +
      'la sesión: al cerrarla se borra. Máximo 10 por cuenta (se borran los menos usados).',
  })
  @ApiOkResponse({ type: DeviceDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  registerDevice(
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterDeviceDto,
  ): Promise<DeviceDto> {
    return this.devices.register(user.id, user.sessionId, dto);
  }

  @Get('devices')
  @ApiOperation({ summary: 'RF-NOT-001: mis dispositivos con push (sin el token)' })
  @ApiOkResponse({ type: DeviceListDto })
  async listDevices(@CurrentUser() user: AuthUser): Promise<DeviceListDto> {
    return { items: await this.devices.list(user.id) };
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'RF-NOT-001: dejar de recibir push en un dispositivo (por su ID)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  removeDevice(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<void> {
    return this.devices.remove(user.id, id);
  }

  // ───────────── Bandeja (RF-NOT-004) ─────────────

  @Get('notifications')
  @ApiOperation({
    summary: 'RF-NOT-004: bandeja de avisos (los más recientes primero; se conservan 90 días)',
  })
  @ApiOkResponse({ type: NotificationPageDto })
  inbox(
    @CurrentUser() user: AuthUser,
    @Query() query: NotificationQueryDto,
  ): Promise<Page<NotificationDto>> {
    return this.notifications.inbox(user.id, query);
  }

  @Get('notifications/unread-count')
  @ApiOperation({ summary: 'RF-NOT-004: avisos sin leer' })
  @ApiOkResponse({ type: UnreadCountDto })
  async unread(@CurrentUser() user: AuthUser): Promise<UnreadCountDto> {
    return { unread: await this.notifications.unreadCount(user.id) };
  }

  @Post('notifications/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'RF-NOT-004: marcar un aviso como leído' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  markRead(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<void> {
    return this.notifications.markRead(user.id, id);
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RF-NOT-004: marcar todos como leídos' })
  @ApiOkResponse({ type: MarkedReadDto })
  async markAllRead(@CurrentUser() user: AuthUser): Promise<MarkedReadDto> {
    return { updated: await this.notifications.markAllRead(user.id) };
  }
}
