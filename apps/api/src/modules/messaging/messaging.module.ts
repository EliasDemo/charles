import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import {
  AdminAccessGuard,
  CurrentStaff,
  type StaffActor,
  SupportOrAdmin,
} from '../admin/admin-access';
import { AdminAccessModule } from '../admin/admin-access.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { ImageStorageModule } from '../images/image-storage.module';
import {
  ContactBarberDto,
  ConversationDto,
  ConversationPageDto,
  ConversationsQueryDto,
  MessageDto,
  MessagePageDto,
  MessageReportPageDto,
  ReportMessageDto,
  ResolveMessageReportDto,
  SendMessageDto,
  StartConversationDto,
  UnreadMessagesDto,
} from './dto/messaging.dto';
import { MessagingService } from './messaging.service';

const uuid = new ParseUUIDPipe();

/** Correo interno: mis conversaciones con barberías (como cliente o como barbero). */
@ApiTags('messages')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('me/conversations')
export class MyConversationsController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  @ApiOperation({ summary: 'Mis conversaciones (más recientes primero), con no leídos' })
  @ApiOkResponse({ type: ConversationPageDto })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ConversationsQueryDto,
  ): Promise<ConversationPageDto> {
    return this.messaging.listForUser(user.id, query);
  }

  @Get('unread')
  @ApiOperation({ summary: 'Cuántas conversaciones tienen mensajes sin leer' })
  @ApiOkResponse({ type: UnreadMessagesDto })
  async unread(@CurrentUser() user: AuthUser): Promise<UnreadMessagesDto> {
    return { conversations: await this.messaging.unreadForUser(user.id) };
  }

  @Post()
  @RateLimit('messages')
  @ApiOperation({
    summary: 'Escribir a una barbería (consulta, o como barbero con kind=PROFESSIONAL)',
    description: 'Si ya existe la conversación, el mensaje se agrega a ella.',
  })
  @ApiCreatedResponse({ type: MessagePageDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'CONVERSATION_BLOCKED' })
  start(@CurrentUser() user: AuthUser, @Body() dto: StartConversationDto): Promise<MessagePageDto> {
    return this.messaging.startAsUser(user.id, dto);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Mensajes (más recientes primero); la primera página marca como leída' })
  @ApiOkResponse({ type: MessagePageDto })
  messages(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: ConversationsQueryDto,
  ): Promise<MessagePageDto> {
    return this.messaging.messages(this.messaging.userViewer(user.id), id, query);
  }

  @Post(':id/messages')
  @RateLimit('messages')
  @ApiOperation({ summary: 'Responder' })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'CONVERSATION_BLOCKED' })
  send(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: SendMessageDto,
  ): Promise<MessageDto> {
    return this.messaging.send(this.messaging.userViewer(user.id), id, dto.body);
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bloquear la conversación (nadie puede escribir)' })
  @ApiOkResponse({ type: ConversationDto })
  block(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<ConversationDto> {
    return this.messaging.setBlocked(this.messaging.userViewer(user.id), id, true);
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desbloquear (solo quien bloqueó)' })
  @ApiOkResponse({ type: ConversationDto })
  unblock(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<ConversationDto> {
    return this.messaging.setBlocked(this.messaging.userViewer(user.id), id, false);
  }
}

/** Correo interno de la barbería (OWNER o MANAGER). */
@ApiTags('messages')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('barbershops/:barbershopId/conversations')
export class BarbershopConversationsController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  @ApiOperation({ summary: 'OWNER o MANAGER: conversaciones de la barbería' })
  @ApiOkResponse({ type: ConversationPageDto })
  list(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Query() query: ConversationsQueryDto,
  ): Promise<ConversationPageDto> {
    return this.messaging.listForShop(user.id, barbershopId, query);
  }

  @Post()
  @RateLimit('messages')
  @ApiOperation({
    summary: 'OWNER o MANAGER: escribir a un barbero (desde su perfil profesional)',
    description: 'A clientes no se les escribe primero: se responde cuando ellos escriben.',
  })
  @ApiCreatedResponse({ type: MessagePageDto })
  contact(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Body() dto: ContactBarberDto,
  ): Promise<MessagePageDto> {
    return this.messaging.contactBarber(user.id, barbershopId, dto);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'OWNER o MANAGER: mensajes; la primera página marca como leída' })
  @ApiOkResponse({ type: MessagePageDto })
  async messages(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Param('id', uuid) id: string,
    @Query() query: ConversationsQueryDto,
  ): Promise<MessagePageDto> {
    return this.messaging.messages(
      await this.messaging.shopViewer(user.id, barbershopId),
      id,
      query,
    );
  }

  @Post(':id/messages')
  @RateLimit('messages')
  @ApiOperation({ summary: 'OWNER o MANAGER: responder' })
  @ApiCreatedResponse({ type: MessageDto })
  async send(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Param('id', uuid) id: string,
    @Body() dto: SendMessageDto,
  ): Promise<MessageDto> {
    return this.messaging.send(
      await this.messaging.shopViewer(user.id, barbershopId),
      id,
      dto.body,
    );
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'OWNER o MANAGER: bloquear la conversación' })
  @ApiOkResponse({ type: ConversationDto })
  async block(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Param('id', uuid) id: string,
  ): Promise<ConversationDto> {
    return this.messaging.setBlocked(
      await this.messaging.shopViewer(user.id, barbershopId),
      id,
      true,
    );
  }

  @Post(':id/unblock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'OWNER o MANAGER: desbloquear (solo si la bloqueó la barbería)' })
  @ApiOkResponse({ type: ConversationDto })
  async unblock(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Param('id', uuid) id: string,
  ): Promise<ConversationDto> {
    return this.messaging.setBlocked(
      await this.messaging.shopViewer(user.id, barbershopId),
      id,
      false,
    );
  }
}

@ApiTags('messages')
@ApiBearerAuth()
@Controller('messages')
export class MessageReportsController {
  constructor(private readonly messaging: MessagingService) {}

  @Post(':id/report')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reportar un mensaje recibido (una vez por persona)' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'ALREADY_REPORTED' })
  async report(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: ReportMessageDto,
  ): Promise<void> {
    await this.messaging.report(user.id, id, dto);
  }
}

/** Moderación de mensajes reportados (soporte o ADMIN). */
@ApiTags('admin')
@ApiBearerAuth()
@SupportOrAdmin()
@UseGuards(AdminAccessGuard)
@Controller('admin/message-reports')
export class MessageReportsAdminController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  @ApiOperation({ summary: 'Mensajes reportados sin resolver (con su texto, solo para soporte)' })
  @ApiOkResponse({ type: MessageReportPageDto })
  list(@Query() query: ConversationsQueryDto): Promise<MessageReportPageDto> {
    return this.messaging.openReports(query);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirar el mensaje o descartar el reporte (con motivo)' })
  @ApiNoContentResponse()
  async resolve(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ResolveMessageReportDto,
  ): Promise<void> {
    await this.messaging.resolveReport(staff.id, id, dto);
  }
}

@Module({
  imports: [BarbershopAccessModule, AdminAccessModule, ImageStorageModule],
  controllers: [
    MyConversationsController,
    BarbershopConversationsController,
    MessageReportsController,
    MessageReportsAdminController,
  ],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
