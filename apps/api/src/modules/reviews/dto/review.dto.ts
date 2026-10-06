import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination';
import {
  ReviewReportReason,
  ReviewReportTarget,
  ReviewStatus,
} from '../../../generated/prisma/enums';
import { COMMENT_MIN, normalizeText, TEXT_MAX } from '../review-policy';

const toPlainText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizeText(value) : value;

// ───────────── Peticiones ─────────────

export class CreateReviewDto {
  @ApiProperty({ minimum: 1, maximum: 5, description: 'Puntuación entera de 1 a 5.' })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({
    minLength: COMMENT_MIN,
    maxLength: TEXT_MAX,
    nullable: true,
    type: String,
    description: 'Texto plano: se recortan los espacios y no se interpreta HTML.',
  })
  @IsOptional()
  @Transform(toPlainText)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MinLength(COMMENT_MIN)
  @MaxLength(TEXT_MAX)
  comment?: string | null;
}

/** Única edición permitida, dentro del plazo. Al menos un campo. */
export class UpdateReviewDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({
    minLength: COMMENT_MIN,
    maxLength: TEXT_MAX,
    nullable: true,
    type: String,
    description: 'null quita el comentario.',
  })
  @IsOptional()
  @Transform(toPlainText)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MinLength(COMMENT_MIN)
  @MaxLength(TEXT_MAX)
  comment?: string | null;
}

export class ReviewResponseInputDto {
  @ApiProperty({ minLength: 1, maxLength: TEXT_MAX, description: 'Texto plano.' })
  @Transform(toPlainText)
  @IsString()
  @MinLength(1)
  @MaxLength(TEXT_MAX)
  text!: string;
}

export class CreateReviewReportDto {
  @ApiPropertyOptional({
    enum: ReviewReportTarget,
    default: ReviewReportTarget.REVIEW,
    description: 'REVIEW: la valoración. RESPONSE: la respuesta de la barbería.',
  })
  @IsOptional()
  @IsEnum(ReviewReportTarget)
  target?: ReviewReportTarget;

  @ApiProperty({ enum: ReviewReportReason })
  @IsEnum(ReviewReportReason)
  reason!: ReviewReportReason;

  @ApiPropertyOptional({ maxLength: TEXT_MAX, type: String })
  @IsOptional()
  @Transform(toPlainText)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(TEXT_MAX)
  details?: string | null;
}

export class BarbershopReviewsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Solo las de este barbero.' })
  @IsOptional()
  @IsUUID()
  barberId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Solo esta puntuación.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3, 4, 5])
  rating?: number;
}

// ───────────── Respuestas ─────────────

export class ReviewBarberDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  displayName!: string;
}

export class ReviewResponseDto {
  @ApiProperty()
  text!: string;

  @ApiProperty({ format: 'date-time' })
  respondedAt!: string;
}

/** RF-VAL-002: lo público. Nunca el contacto del cliente ni su nombre completo. */
export class PublicReviewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  rating!: number;

  @ApiProperty({ nullable: true, type: String })
  comment!: string | null;

  @ApiProperty({ example: 'Ana R.', description: 'Nombre e inicial del apellido.' })
  authorName!: string;

  @ApiProperty({ description: 'Servicio tal como se reservó.' })
  serviceName!: string;

  @ApiProperty({ type: ReviewBarberDto })
  barber!: ReviewBarberDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  editedAt!: string | null;

  @ApiProperty({
    type: ReviewResponseDto,
    nullable: true,
    description: 'Respuesta de la barbería (null si no hay o la ocultó soporte).',
  })
  response!: ReviewResponseDto | null;
}

export class PublicReviewPageDto {
  @ApiProperty({ type: [PublicReviewDto] })
  items!: PublicReviewDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class ReviewBarbershopDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

/** La valoración vista por su autor (incluye estado y si aún puede editarla). */
export class MyReviewDto extends PublicReviewDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ type: ReviewBarbershopDto })
  barbershop!: ReviewBarbershopDto;

  @ApiProperty({
    enum: ReviewStatus,
    description: 'HIDDEN: no se muestra en público (soporte o asistencia corregida).',
  })
  status!: ReviewStatus;

  @ApiProperty({ description: 'Aún se puede editar (una sola vez, dentro del plazo).' })
  canEdit!: boolean;
}

export class MyReviewPageDto {
  @ApiProperty({ type: [MyReviewDto] })
  items!: MyReviewDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
