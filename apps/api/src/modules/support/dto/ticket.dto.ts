import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination';
import {
  BarbershopReportReason,
  TicketCategory,
  TicketStatus,
} from '../../../generated/prisma/enums';
import { normalizeText } from '../../reviews/review-policy';

export const TICKET_MESSAGE_MAX = 2000;
export const RELATED_TYPES = ['booking', 'payment', 'barbershop'] as const;
export type RelatedType = (typeof RELATED_TYPES)[number];

const toPlainText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizeText(value) : value;

// ───────────── Peticiones del usuario ─────────────

export class CreateTicketDto {
  @ApiProperty({ enum: TicketCategory })
  @IsEnum(TicketCategory)
  category!: TicketCategory;

  @ApiProperty({ minLength: 3, maxLength: 120 })
  @Transform(toPlainText)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  subject!: string;

  @ApiProperty({ minLength: 1, maxLength: TICKET_MESSAGE_MAX, description: 'Primer mensaje.' })
  @Transform(toPlainText)
  @IsString()
  @MinLength(1)
  @MaxLength(TICKET_MESSAGE_MAX)
  message!: string;

  @ApiPropertyOptional({
    enum: RELATED_TYPES,
    description: 'Relación opcional con una reserva, un pago o una barbería propios.',
  })
  @IsOptional()
  @IsIn(RELATED_TYPES)
  relatedType?: RelatedType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Obligatorio con relatedType.' })
  @ValidateIf((dto: CreateTicketDto) => dto.relatedType !== undefined)
  @IsUUID()
  relatedId?: string;
}

export class TicketMessageInputDto {
  @ApiProperty({ minLength: 1, maxLength: TICKET_MESSAGE_MAX })
  @Transform(toPlainText)
  @IsString()
  @MinLength(1)
  @MaxLength(TICKET_MESSAGE_MAX)
  body!: string;
}

// ───────────── Peticiones de soporte ─────────────

export class StaffTicketMessageInputDto extends TicketMessageInputDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Nota interna: nunca la ve el usuario y no cambia el estado.',
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

export class AssignTicketDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Cuenta de soporte o ADMIN; por defecto, quien hace la petición.',
  })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;
}

export class UpdateTicketStatusDto {
  @ApiProperty({ enum: [TicketStatus.IN_PROGRESS, TicketStatus.RESOLVED, TicketStatus.CLOSED] })
  @IsIn([TicketStatus.IN_PROGRESS, TicketStatus.RESOLVED, TicketStatus.CLOSED])
  status!: TicketStatus;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Obligatorio al cerrar un ticket que no está resuelto.',
  })
  @IsOptional()
  @Transform(toPlainText)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}

export class TicketQueueQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: TicketStatus,
    description: 'Por defecto, los abiertos (OPEN e IN_PROGRESS).',
  })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TicketCategory })
  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  @ApiPropertyOptional({ enum: ['me', 'unassigned', 'any'], default: 'any' })
  @IsOptional()
  @IsIn(['me', 'unassigned', 'any'])
  assigned?: 'me' | 'unassigned' | 'any';
}

// ───────────── Reportes de barberías ─────────────

export class CreateBarbershopReportDto {
  @ApiProperty({ enum: BarbershopReportReason })
  @IsEnum(BarbershopReportReason)
  reason!: BarbershopReportReason;

  @ApiPropertyOptional({ maxLength: 500, type: String })
  @IsOptional()
  @Transform(toPlainText)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  details?: string | null;
}

// ───────────── Respuestas ─────────────

export class TicketRelatedDto {
  @ApiProperty({ enum: RELATED_TYPES })
  type!: RelatedType;

  @ApiProperty({ format: 'uuid' })
  id!: string;
}

export class TicketSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: TicketCategory })
  category!: TicketCategory;

  @ApiProperty()
  subject!: string;

  @ApiProperty({ enum: TicketStatus })
  status!: TicketStatus;

  @ApiProperty({ type: TicketRelatedDto, nullable: true })
  related!: TicketRelatedDto | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  resolvedAt!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  closedAt!: string | null;
}

export class TicketPageDto {
  @ApiProperty({ type: [TicketSummaryDto] })
  items!: TicketSummaryDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

/** Mensaje visto por el usuario: nunca notas internas ni quién de soporte respondió. */
export class TicketMessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ enum: ['USER', 'SUPPORT'] })
  from!: 'USER' | 'SUPPORT';

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class TicketDetailDto extends TicketSummaryDto {
  @ApiProperty({ type: [TicketMessageDto] })
  messages!: TicketMessageDto[];

  @ApiProperty({ description: 'Si puede responder (abierto, o resuelto dentro del plazo).' })
  canReply!: boolean;
}

export class StaffPersonDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

export class StaffTicketMessageDto extends TicketMessageDto {
  @ApiProperty()
  isInternal!: boolean;

  @ApiProperty({ type: StaffPersonDto })
  author!: StaffPersonDto;
}

export class StaffTicketDto extends TicketSummaryDto {
  @ApiProperty({ type: StaffPersonDto })
  requester!: StaffPersonDto;

  @ApiProperty({ type: StaffPersonDto, nullable: true })
  assignedTo!: StaffPersonDto | null;
}

export class StaffTicketPageDto {
  @ApiProperty({ type: [StaffTicketDto] })
  items!: StaffTicketDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class StaffTicketDetailDto extends StaffTicketDto {
  @ApiProperty({ type: [StaffTicketMessageDto] })
  messages!: StaffTicketMessageDto[];
}
