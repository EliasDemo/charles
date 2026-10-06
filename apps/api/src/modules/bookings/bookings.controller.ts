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
import { BookingsService } from './bookings.service';
import {
  BookingDto,
  BookingListQueryDto,
  BookingPageDto,
  CancelBookingDto,
  CreateBookingDto,
  CreatedBookingDto,
} from './dto/booking.dto';

const uuid = new ParseUUIDPipe();

@ApiTags('bookings')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

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

  @Post('bookings/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'RF-RES-005: cancelar (cliente, o OWNER/MANAGER con motivo; el barbero no)',
  })
  @ApiOkResponse({ type: BookingDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CancelBookingDto,
  ): Promise<BookingDto> {
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
