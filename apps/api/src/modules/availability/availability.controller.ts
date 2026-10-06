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
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import type { Slot } from './engine/compute-slots';
import { AvailabilityService } from './availability.service';
import {
  AvailabilityQueryDto,
  AvailableNowDto,
  BarberScheduleDto,
  BarberScheduleUpdateDto,
  BusinessHoursDto,
  BusinessHoursUpdateDto,
  CreateTimeBlockDto,
  DayAvailabilityDto,
  DayAvailabilityQueryDto,
  NextAvailabilityDto,
  type SlotDto,
  TimeBlockDto,
  TimeBlockListQueryDto,
  WeeklyScheduleDto,
} from './dto/availability.dto';
import { ScheduleService } from './schedule.service';

const uuid = new ParseUUIDPipe();

/** Privacidad: solo turnos e ID de barberos libres (nunca bloqueos, motivos, reservas ni clientes). */
const toSlotDto = (slot: Slot): SlotDto => ({
  startAt: new Date(slot.start),
  endAt: new Date(slot.end),
  barberIds: slot.barberIds,
});

@ApiTags('availability')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class AvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly schedules: ScheduleService,
  ) {}

  // ───────────── Público ─────────────

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/business-hours')
  @ApiOperation({ summary: 'RF-DIS-001 / RF-BAR-002: horario semanal e indicador "abierta ahora"' })
  @ApiOkResponse({ type: BusinessHoursDto })
  businessHours(@Param('id', uuid) id: string): Promise<BusinessHoursDto> {
    return this.schedules.publicBusinessHours(id);
  }

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/availability')
  @ApiOperation({
    summary: 'RF-DIS-003: turnos de una fecha (local de la barbería) para un servicio',
  })
  @ApiOkResponse({ type: DayAvailabilityDto })
  async forDate(
    @Param('id', uuid) id: string,
    @Query() query: DayAvailabilityQueryDto,
  ): Promise<DayAvailabilityDto> {
    const { timezone, slots } = await this.availability.slotsForDate(
      { barbershopId: id, serviceId: query.serviceId, barberId: query.barberId },
      query.date,
    );
    return { date: query.date, timezone, slots: slots.map(toSlotDto) };
  }

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/availability/now')
  @ApiOperation({
    summary: 'RF-DIS-002: ¿puede atender ahora? (turno dentro de la ventana "ahora")',
  })
  @ApiOkResponse({ type: AvailableNowDto })
  async now(
    @Param('id', uuid) id: string,
    @Query() query: AvailabilityQueryDto,
  ): Promise<AvailableNowDto> {
    const slot = await this.availability.availableNow({ barbershopId: id, ...query });
    return { available: slot !== null, slot: slot ? toSlotDto(slot) : null };
  }

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/availability/next')
  @ApiOperation({
    summary: 'RF-DIS-004: siguiente turno disponible (hasta el horizonte de reservas)',
  })
  @ApiOkResponse({ type: NextAvailabilityDto })
  async next(
    @Param('id', uuid) id: string,
    @Query() query: AvailabilityQueryDto,
  ): Promise<NextAvailabilityDto> {
    const slot = await this.availability.nextAvailable({ barbershopId: id, ...query });
    return { slot: slot ? toSlotDto(slot) : null };
  }

  // ───────────── Gestión ─────────────

  @ApiBearerAuth()
  @Put('barbershops/:id/business-hours')
  @ApiOperation({ summary: 'RF-DIS-001: configurar el horario semanal (OWNER o MANAGER)' })
  @ApiOkResponse({ type: BusinessHoursUpdateDto })
  putBusinessHours(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: WeeklyScheduleDto,
    @Req() req: Request,
  ): Promise<BusinessHoursUpdateDto> {
    return this.schedules.putBusinessHours(user.id, id, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Get('barbershops/:id/barbers/:barberId/schedule')
  @ApiOperation({ summary: 'RF-BRB-003: horario del barbero (responsables y el propio barbero)' })
  @ApiOkResponse({ type: BarberScheduleDto })
  getBarberSchedule(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
  ): Promise<BarberScheduleDto> {
    return this.schedules.getBarberSchedule(user.id, id, barberId);
  }

  @ApiBearerAuth()
  @Put('barbershops/:id/barbers/:barberId/schedule')
  @ApiOperation({
    summary: 'RF-BRB-003: horario semanal del barbero (solo responsables; vacío = hereda)',
  })
  @ApiOkResponse({ type: BarberScheduleUpdateDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  putBarberSchedule(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
    @Body() dto: WeeklyScheduleDto,
    @Req() req: Request,
  ): Promise<BarberScheduleUpdateDto> {
    return this.schedules.putBarberSchedule(user.id, id, barberId, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Get('barbershops/:id/time-blocks')
  @ApiOperation({ summary: 'Bloqueos (responsables: todos; barbero: los suyos)' })
  @ApiOkResponse({ type: [TimeBlockDto] })
  listBlocks(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: TimeBlockListQueryDto,
  ): Promise<TimeBlockDto[]> {
    return this.schedules.listBlocks(user.id, id, query);
  }

  @ApiBearerAuth()
  @Post('barbershops/:id/time-blocks')
  @ApiOperation({
    summary: 'RF-DIS-001 / RF-BRB-003: bloquear (descanso, ausencia, feriado, manual)',
  })
  @ApiCreatedResponse({ type: TimeBlockDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'Choca con reservas activas' })
  createBlock(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CreateTimeBlockDto,
    @Req() req: Request,
  ): Promise<TimeBlockDto> {
    return this.schedules.createBlock(user.id, id, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Delete('barbershops/:id/time-blocks/:blockId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un bloqueo' })
  @ApiNoContentResponse()
  deleteBlock(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('blockId', uuid) blockId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.schedules.deleteBlock(user.id, id, blockId, req.ip ?? null);
  }
}
