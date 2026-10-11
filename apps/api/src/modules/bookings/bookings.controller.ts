import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { BookingCreationRateLimitGuard } from './booking-rate-limit';
import { BookingAttendanceService } from './booking-attendance.service';
import { BookingsService } from './bookings.service';
import {
  AgendaDto,
  AgendaQueryDto,
  AttendanceCorrectionDto,
  BarbershopAgendaQueryDto,
} from './dto/attendance.dto';
import {
  BookingDto,
  BookingListQueryDto,
  BookingPageDto,
  CancelBookingDto,
  CancellationPreviewDto,
  CancelledBookingDto,
  CreateBookingDto,
  CreatedBookingDto,
  PendingReviewsDto,
} from './dto/booking.dto';

const uuid = new ParseUUIDPipe();

@ApiTags('bookings')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly attendance: BookingAttendanceService,
  ) {}

  @Post('bookings')
  @UseGuards(BookingCreationRateLimitGuard)
  @ApiOperation({
    summary: 'RF-RES-001/002: crear una reserva (pendiente de pago) en un turno disponible',
    description:
      'Idempotente por la cabecera Idempotency-Key: repetir la misma petición devuelve la misma ' +
      'reserva (200). Requiere correo verificado.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID único por intento.' })
  @ApiCreatedResponse({ type: CreatedBookingDto })
  @ApiOkResponse({ type: CreatedBookingDto, description: 'Repetición con la misma clave.' })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  async create(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateBookingDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreatedBookingDto> {
    const { booking, replayed } = await this.bookings.create(user.id, idempotencyKey, dto);
    res.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return booking;
  }

  @Get('bookings/:id')
  @ApiOperation({ summary: 'RF-RES-004: detalle (cliente, responsables o barbero asignado)' })
  @ApiOkResponse({ type: BookingDto })
  findOne(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<BookingDto> {
    return this.bookings.findOne(user.id, id);
  }

  @Get('bookings/:id/cancellation-preview')
  @ApiOperation({
    summary: 'RF-RES-005: si se puede cancelar ahora y cuánto se devolvería (antes de confirmar)',
  })
  @ApiOkResponse({ type: CancellationPreviewDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  cancellationPreview(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<CancellationPreviewDto> {
    return this.bookings.cancellationPreview(user.id, id);
  }

  @Post('bookings/:id/attended')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'RF-ATE-002: marcar como atendida (barbero asignado o barbería; desde el inicio y hasta 24 h)',
  })
  @ApiOkResponse({ type: BookingDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async markAttended(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<BookingDto> {
    await this.attendance.markAttended(user.id, id);
    return this.bookings.findOne(user.id, id);
  }

  @Post('bookings/:id/attendance-correction')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Corregir ATTENDED ↔ NO_SHOW (solo OWNER o MANAGER, con motivo, hasta 48 h)',
  })
  @ApiOkResponse({ type: BookingDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async correctAttendance(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: AttendanceCorrectionDto,
  ): Promise<BookingDto> {
    await this.attendance.correct(user.id, id, dto);
    return this.bookings.findOne(user.id, id);
  }

  @Get('me/barber/agenda')
  @ApiOperation({ summary: 'RF-ATE-001: mi agenda del día como barbero (pendientes de atención)' })
  @ApiOkResponse({ type: AgendaDto })
  barberAgenda(@CurrentUser() user: AuthUser, @Query() query: AgendaQueryDto): Promise<AgendaDto> {
    return this.attendance.barberAgenda(user.id, query.date);
  }

  @Get('barbershops/:id/agenda')
  @ApiOperation({ summary: 'RF-ATE-001: agenda del día de la barbería (OWNER o MANAGER)' })
  @ApiOkResponse({ type: AgendaDto })
  barbershopAgenda(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: BarbershopAgendaQueryDto,
  ): Promise<AgendaDto> {
    return this.attendance.barbershopAgenda(user.id, id, query.date, query.barberId);
  }

  @Post('bookings/:id/no-show')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Marcar inasistencia (barbero asignado o barbería; de 15 min a 24 h tras el inicio)',
  })
  @ApiOkResponse({ type: BookingDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  markNoShow(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<BookingDto> {
    return this.bookings.markNoShow(user.id, id);
  }

  @Post('bookings/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'RF-RES-005: cancelar (cliente, o OWNER/MANAGER con motivo; el barbero no)',
  })
  @ApiOkResponse({ type: CancelledBookingDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CancelBookingDto,
  ): Promise<CancelledBookingDto> {
    return this.bookings.cancel(user.id, id, dto);
  }

  @Get('me/bookings')
  @ApiOperation({ summary: 'RF-RES-004/008: mis reservas (próximas o historial)' })
  @ApiOkResponse({ type: BookingPageDto })
  listMine(
    @CurrentUser() user: AuthUser,
    @Query() query: BookingListQueryDto,
  ): Promise<BookingPageDto> {
    return this.bookings.listMine(user.id, query);
  }

  @Get('me/bookings/pending-reviews')
  @ApiOperation({
    summary: 'M9: reservas que puedo valorar ahora (aviso "¿Cómo te fue con tu corte?")',
    description:
      'Las mismas que tienen canReview = true en BookingDto, las más recientes primero (hasta 20).',
  })
  @ApiOkResponse({ type: PendingReviewsDto })
  pendingReviews(@CurrentUser() user: AuthUser): Promise<PendingReviewsDto> {
    return this.bookings.pendingReviews(user.id);
  }

  @Get('me/barber/bookings')
  @ApiOperation({ summary: 'RF-RES-004/008: reservas que debo atender como barbero' })
  @ApiOkResponse({ type: BookingPageDto })
  listForBarber(
    @CurrentUser() user: AuthUser,
    @Query() query: BookingListQueryDto,
  ): Promise<BookingPageDto> {
    return this.bookings.listForBarber(user.id, query);
  }

  @Get('barbershops/:id/bookings')
  @ApiOperation({ summary: 'RF-RES-004/008: reservas de mi barbería (OWNER o MANAGER)' })
  @ApiOkResponse({ type: BookingPageDto })
  listForBarbershop(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: BookingListQueryDto,
  ): Promise<BookingPageDto> {
    return this.bookings.listForBarbershop(user.id, id, query);
  }
}
