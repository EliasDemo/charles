import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { BookingStatus, TimeBlockType } from '../../../generated/prisma/enums';
import { NamedRefDto } from './booking.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Corrección de una marca de asistencia (solo OWNER o MANAGER, con motivo). */
export class AttendanceCorrectionDto {
  @ApiProperty({ enum: ['ATTENDED', 'NO_SHOW'], description: 'Estado correcto.' })
  @IsIn(['ATTENDED', 'NO_SHOW'])
  status!: 'ATTENDED' | 'NO_SHOW';

  @ApiProperty({ description: 'Motivo de la corrección (queda en el historial y la auditoría).' })
  @Transform(trim)
  @IsString()
  @Length(3, 300)
  reason!: string;
}

export class AgendaQueryDto {
  @ApiPropertyOptional({
    example: '2030-01-07',
    description: 'Día local de la barbería (YYYY-MM-DD). Por defecto, hoy.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

export class BarbershopAgendaQueryDto extends AgendaQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Solo la agenda de este barbero.' })
  @IsOptional()
  @IsUUID()
  barberId?: string;
}

export class AgendaActionsDto {
  @ApiProperty()
  canMarkAttended!: boolean;

  @ApiProperty()
  canMarkNoShow!: boolean;

  @ApiProperty({ description: 'Solo OWNER o MANAGER, dentro del plazo de corrección.' })
  canCorrect!: boolean;
}

export class AgendaItemDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status!: BookingStatus;

  @ApiProperty()
  startAt!: Date;

  @ApiProperty()
  endAt!: Date;

  @ApiProperty({ type: NamedRefDto })
  service!: NamedRefDto;

  @ApiProperty({ type: NamedRefDto })
  barber!: NamedRefDto;

  @ApiProperty({
    type: NamedRefDto,
    description: 'Solo el nombre (sin teléfono, correo ni documento).',
  })
  client!: NamedRefDto;

  @ApiProperty({ description: 'PENDING_PAYMENT vigente: por confirmar.' })
  awaitingPayment!: boolean;

  @ApiProperty({ description: 'CONFIRMED que ya empezó y sigue sin marcar (RF-ATE-001).' })
  pendingAttention!: boolean;

  @ApiProperty({ type: AgendaActionsDto, description: 'Lo que quien consulta puede hacer ahora.' })
  actions!: AgendaActionsDto;
}

export class AgendaBlockDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'null = toda la barbería.',
  })
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

export class AgendaDto {
  @ApiProperty({ example: '2030-01-07' })
  date!: string;

  @ApiProperty({ example: 'America/Lima' })
  timezone!: string;

  @ApiProperty({ type: NamedRefDto })
  barbershop!: NamedRefDto;

  @ApiProperty({ type: [AgendaItemDto], description: 'Por hora de inicio.' })
  items!: AgendaItemDto[];

  @ApiProperty({ type: [AgendaBlockDto] })
  blocks!: AgendaBlockDto[];

  @ApiProperty({ description: 'Reservas confirmadas que ya empezaron y siguen sin marcar.' })
  pendingAttention!: number;
}
