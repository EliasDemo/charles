import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { AllowRestrictedSession } from '../../common/auth/restricted-session.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { type Page, PaginationQueryDto } from '../../common/pagination/pagination';
import {
  AdminAccessGuard,
  CurrentStaff,
  type StaffActor,
  SupportOrAdmin,
} from '../admin/admin-access';
import { ReviewWriteRateLimitGuard } from '../reviews/review-rate-limit';
import { BarbershopReportsService } from './barbershop-reports.service';
import {
  AssignTicketDto,
  CreateBarbershopReportDto,
  CreateTicketDto,
  StaffTicketDetailDto,
  type StaffTicketDto,
  StaffTicketMessageInputDto,
  StaffTicketPageDto,
  TicketDetailDto,
  TicketMessageInputDto,
  TicketPageDto,
  TicketQueueQueryDto,
  type TicketSummaryDto,
  UpdateTicketStatusDto,
} from './dto/ticket.dto';
import { TicketsService } from './tickets.service';

const uuid = new ParseUUIDPipe();

/** RF-SOP-001: tickets del usuario; también para la sesión restringida de una cuenta deshabilitada. */
@ApiTags('support')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@AllowRestrictedSession()
@Controller()
export class SupportController {
  constructor(private readonly tickets: TicketsService) {}

  @Post('support/tickets')
  @ApiOperation({
    summary: 'RF-SOP-001: abrir un ticket de soporte',
    description:
      'Relación opcional con una reserva, un pago o una barbería propios. Máximo ' +
      'support.max_open_tickets_per_user (5) abiertos a la vez.',
  })
  @ApiCreatedResponse({ type: TicketDetailDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto): Promise<TicketDetailDto> {
    return this.tickets.create(user.id, dto);
  }

  @Get('me/support/tickets')
  @ApiOperation({ summary: 'RF-SOP-001: mis tickets (los más recientes primero)' })
  @ApiOkResponse({ type: TicketPageDto })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationQueryDto,
  ): Promise<Page<TicketSummaryDto>> {
    return this.tickets.listMine(user.id, query);
  }

  @Get('me/support/tickets/:id')
  @ApiOperation({ summary: 'RF-SOP-001: un ticket propio con sus mensajes (sin notas internas)' })
  @ApiOkResponse({ type: TicketDetailDto })
  get(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<TicketDetailDto> {
    return this.tickets.getMine(user.id, id);
  }

  @Post('me/support/tickets/:id/messages')
  @ApiOperation({
    summary: 'RF-SOP-001: responder en un ticket propio',
    description:
      'Un ticket RESOLVED se reabre si se responde dentro de support.ticket_reopen_days (7). ' +
      'Cerrado o fuera de plazo: 409 TICKET_CLOSED.',
  })
  @ApiCreatedResponse({ type: TicketDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  reply(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: TicketMessageInputDto,
  ): Promise<TicketDetailDto> {
    return this.tickets.replyAsUser(user.id, id, dto.body);
  }
}

@ApiTags('support')
@ApiBearerAuth()
@Controller()
export class BarbershopReportsController {
  constructor(private readonly reports: BarbershopReportsService) {}

  @Post('barbershops/:id/reports')
  @UseGuards(ReviewWriteRateLimitGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Fase 12: reportar una barbería (una vez por cuenta)',
    description:
      'Sus miembros no la reportan (403). Comparte el límite de valoraciones y reportes.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  report(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) barbershopId: string,
    @Body() dto: CreateBarbershopReportDto,
  ): Promise<void> {
    return this.reports.create(user.id, barbershopId, dto);
  }
}

/** RF-SOP-002/003: cola de tickets para soporte. */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@SupportOrAdmin()
@UseGuards(AdminAccessGuard)
@Controller('admin/tickets')
export class AdminTicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @ApiOperation({ summary: 'RF-SOP-002: cola de tickets (los más antiguos primero)' })
  @ApiOkResponse({ type: StaffTicketPageDto })
  queue(
    @CurrentStaff() staff: StaffActor,
    @Query() query: TicketQueueQueryDto,
  ): Promise<Page<StaffTicketDto>> {
    return this.tickets.queue(staff, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'RF-SOP-002: ticket con todos sus mensajes (incluidas notas internas)' })
  @ApiOkResponse({ type: StaffTicketDetailDto })
  get(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
  ): Promise<StaffTicketDetailDto> {
    return this.tickets.getForStaff(staff, id);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RF-SOP-002: tomar o reasignar un ticket' })
  @ApiOkResponse({ type: StaffTicketDetailDto })
  assign(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: AssignTicketDto,
  ): Promise<StaffTicketDetailDto> {
    return this.tickets.assign(staff, id, dto);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'RF-SOP-003: responder al usuario o dejar una nota interna' })
  @ApiCreatedResponse({ type: StaffTicketDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  reply(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: StaffTicketMessageInputDto,
  ): Promise<StaffTicketDetailDto> {
    return this.tickets.replyAsStaff(staff, id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'RF-SOP-003: cambiar el estado (resolver, reabrir, cerrar)' })
  @ApiOkResponse({ type: StaffTicketDetailDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  setStatus(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateTicketStatusDto,
  ): Promise<StaffTicketDetailDto> {
    return this.tickets.setStatus(staff, id, dto);
  }
}
