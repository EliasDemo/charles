import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TimeBlockType } from '../../../generated/prisma/enums';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ───────────── Horarios ─────────────

export class WindowDto {
  @ApiProperty({ example: '09:00', description: 'Hora local, múltiplo de 5 minutos.' })
  @Matches(HHMM)
  start!: string;

  @ApiProperty({
    example: '13:00',
    description: 'Hora local, posterior al inicio (sin cruzar la medianoche).',
  })
  @Matches(HHMM)
  end!: string;
}

export class DayScheduleDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = domingo … 6 = sábado.' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ type: [WindowDto], description: 'Varias ventanas por día permiten descansos.' })
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => WindowDto)
  windows!: WindowDto[];
}

/** Semana completa: reemplaza la anterior. Los días omitidos no se atienden. */
export class WeeklyScheduleDto {
  @ApiProperty({ type: [DayScheduleDto] })
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => DayScheduleDto)
  days!: DayScheduleDto[];
}

export class BusinessHoursDto {
  @ApiProperty({ example: 'America/Lima' })
  timezone!: string;

  @ApiProperty({
    description: 'Abierta ahora: estado OPEN, dentro del horario y sin bloqueo general.',
  })
  isOpenNow!: boolean;

  @ApiProperty({ type: [DayScheduleDto] })
  days!: DayScheduleDto[];
}

export class BusinessHoursUpdateDto extends BusinessHoursDto {
  @ApiProperty({
    description: 'Reservas futuras activas que quedan fuera del horario nuevo (se mantienen).',
  })
  bookingsOutsideSchedule!: number;
}

export class BarberScheduleDto {
  @ApiProperty({ format: 'uuid' })
  barberId!: string;

  @ApiProperty({ description: 'true: no tiene horario propio y usa el de la barbería.' })
  inheritsBusinessHours!: boolean;

  @ApiProperty({ type: [DayScheduleDto] })
  days!: DayScheduleDto[];
}

export class BarberScheduleUpdateDto extends BarberScheduleDto {
  @ApiProperty()
  bookingsOutsideSchedule!: number;
}

// ───────────── Bloqueos ─────────────

export class CreateTimeBlockDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Vacío = bloqueo de toda la barbería.' })
  @IsOptional()
  @IsUUID()
  barberId?: string;

  @ApiProperty({ description: 'Instante ISO 8601 (múltiplo de 5 minutos).' })
  @Type(() => Date)
  @IsDate()
  startAt!: Date;

  @ApiProperty({ description: 'Instante ISO 8601, posterior al inicio.' })
  @Type(() => Date)
  @IsDate()
  endAt!: Date;

  @ApiProperty({ enum: TimeBlockType, enumName: 'TimeBlockType' })
  @IsEnum(TimeBlockType)
  type!: TimeBlockType;

  @ApiPropertyOptional({ description: 'Solo lo ven los responsables y el propio barbero.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class TimeBlockListQueryDto {
  @ApiPropertyOptional({ description: 'Desde (ISO). Por defecto, ahora.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Hasta (ISO). Por defecto, el horizonte de reservas.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class TimeBlockDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  barberId!: string | null;

  @ApiProperty()
  startAt!: Date;

  @ApiProperty()
  endAt!: Date;

  @ApiProperty({ enum: TimeBlockType, enumName: 'TimeBlockType' })
  type!: TimeBlockType;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;
}

// ───────────── Disponibilidad pública ─────────────

export class AvailabilityQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sin barbero = cualquier barbero disponible.',
  })
  @IsOptional()
  @IsUUID()
  barberId?: string;
}

export class DayAvailabilityQueryDto extends AvailabilityQueryDto {
  @ApiProperty({ example: '2030-01-07', description: 'Fecha local de la barbería (YYYY-MM-DD).' })
  @Matches(LOCAL_DATE)
  date!: string;
}

/** Solo turnos e ID de barberos libres: nunca bloqueos, motivos, reservas ni clientes. */
export class SlotDto {
  @ApiProperty()
  startAt!: Date;

  @ApiProperty()
  endAt!: Date;

  @ApiProperty({ type: [String] })
  barberIds!: string[];
}

export class DayAvailabilityDto {
  @ApiProperty({ example: '2030-01-07' })
  date!: string;

  @ApiProperty({ example: 'America/Lima' })
  timezone!: string;

  @ApiProperty({ type: [SlotDto] })
  slots!: SlotDto[];
}

export class AvailableNowDto {
  @ApiProperty()
  available!: boolean;

  @ApiProperty({ type: SlotDto, nullable: true })
  slot!: SlotDto | null;
}

export class NextAvailabilityDto {
  @ApiProperty({ type: SlotDto, nullable: true })
  slot!: SlotDto | null;
}
