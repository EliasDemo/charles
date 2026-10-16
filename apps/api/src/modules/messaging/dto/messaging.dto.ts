import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const CURSOR = /^[A-Za-z0-9_-]+$/;

export const MESSAGE_MAX_LENGTH = 2000;
export const REPORT_REASONS = ['SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'SCAM', 'OTHER'] as const;

export class SendMessageDto {
  @ApiProperty({ minLength: 1, maxLength: MESSAGE_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @Length(1, MESSAGE_MAX_LENGTH)
  body!: string;
}

/** La persona escribe a una barbería (consulta) o, si es barbero, por trabajo. */
export class StartConversationDto extends SendMessageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  barbershopId!: string;

  @ApiPropertyOptional({
    enum: ['CLIENT', 'PROFESSIONAL'],
    default: 'CLIENT',
    description: 'PROFESSIONAL: como barbero (exige perfil profesional).',
  })
  @IsOptional()
  @IsIn(['CLIENT', 'PROFESSIONAL'])
  kind?: 'CLIENT' | 'PROFESSIONAL';
}

/** La barbería escribe a un barbero desde su perfil (no puede escribir primero a clientes). */
export class ContactBarberDto extends SendMessageDto {
  @ApiProperty({ format: 'uuid', description: 'Perfil profesional del barbero.' })
  @IsUUID()
  barberProfileId!: string;
}

export class ConversationsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(CURSOR)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class ReportMessageDto {
  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS)
  reason!: (typeof REPORT_REASONS)[number];

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  details?: string;
}

export class ResolveMessageReportDto {
  @ApiProperty({ enum: ['REMOVE', 'DISMISS'], description: 'REMOVE retira el mensaje.' })
  @IsIn(['REMOVE', 'DISMISS'])
  action!: 'REMOVE' | 'DISMISS';

  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class CounterpartDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Si el otro lado es un barbero con perfil profesional.',
  })
  barberProfileId!: string | null;
}

export class ConversationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['CLIENT', 'PROFESSIONAL'] })
  kind!: 'CLIENT' | 'PROFESSIONAL';

  @ApiProperty({ type: CounterpartDto, description: 'Con quién hablo (la barbería o la persona).' })
  counterpart!: CounterpartDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Inicio del último mensaje (120 caracteres).',
  })
  lastMessagePreview!: string | null;

  @ApiProperty()
  lastMessageAt!: Date;

  @ApiProperty()
  unread!: number;

  @ApiProperty({ description: 'Bloqueada: nadie puede escribir.' })
  blocked!: boolean;

  @ApiProperty({ description: 'La bloqueé yo (puedo desbloquearla).' })
  blockedByMe!: boolean;
}

export class ConversationPageDto {
  @ApiProperty({ type: [ConversationDto] })
  items!: ConversationDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class MessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['BARBERSHOP', 'USER', 'SYSTEM'] })
  side!: 'BARBERSHOP' | 'USER' | 'SYSTEM';

  @ApiProperty({ description: 'Lo escribí yo (mi lado de la conversación).' })
  mine!: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'Quién lo escribió (nombre de pila).' })
  senderName!: string | null;

  @ApiProperty({ description: 'Texto; "Mensaje retirado por soporte." si se retiró.' })
  body!: string;

  @ApiProperty()
  removed!: boolean;

  @ApiProperty()
  createdAt!: Date;
}

export class MessagePageDto {
  @ApiProperty({ type: ConversationDto })
  conversation!: ConversationDto;

  @ApiProperty({ type: [MessageDto], description: 'Más recientes primero.' })
  items!: MessageDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class MessageReportDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  messageId!: string;

  @ApiProperty({ enum: REPORT_REASONS })
  reason!: string;

  @ApiProperty({ type: String, nullable: true })
  details!: string | null;

  @ApiProperty({ description: 'Texto del mensaje reportado (solo para soporte).' })
  messageBody!: string;

  @ApiProperty({ enum: ['BARBERSHOP', 'USER', 'SYSTEM'] })
  messageSide!: string;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty()
  userName!: string;

  @ApiProperty()
  removed!: boolean;

  @ApiProperty()
  createdAt!: Date;
}

export class MessageReportPageDto {
  @ApiProperty({ type: [MessageReportDto] })
  items!: MessageReportDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class UnreadMessagesDto {
  @ApiProperty({ description: 'Conversaciones con mensajes sin leer (como persona).' })
  conversations!: number;
}
