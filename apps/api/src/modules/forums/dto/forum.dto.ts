import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const THREAD_SORTS = ['recent', 'new', 'unanswered'] as const;
export const REPLY_SORTS = ['oldest', 'helpful'] as const;

// ───────────── Temas ─────────────

export class ForumCategoryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'tecnicas-de-corte' })
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ description: 'Hilos visibles del tema.' })
  threadCount!: number;
}

export class AdminForumCategoryDto extends ForumCategoryDto {
  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;
}

export class CreateForumCategoryDto {
  @ApiProperty({ example: 'tecnicas-de-corte', description: 'a-z, 0-9 y guion (2 a 40).' })
  @Matches(/^[a-z0-9-]{2,40}$/)
  slug!: string;

  @ApiProperty({ minLength: 2, maxLength: 60 })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  name!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  description?: string;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class UpdateForumCategoryDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  description?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'false: el tema deja de verse y no admite hilos nuevos.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ───────────── Hilos ─────────────

export class ForumAuthorDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ description: 'Tiene perfil profesional de barbero (insignia "Barbero").' })
  isBarber!: boolean;
}

export class ThreadsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ maxLength: 60, description: 'Busca en el título.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  q?: string;

  @ApiPropertyOptional({
    enum: THREAD_SORTS,
    default: 'recent',
    description:
      'recent: actividad reciente (fijados primero); new: los más nuevos; ' +
      'unanswered: sin respuestas.',
  })
  @IsOptional()
  @IsIn(THREAD_SORTS)
  sort?: (typeof THREAD_SORTS)[number];

  @ApiPropertyOptional({ description: 'Valor de nextCursor (opaco).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class CreateThreadDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ minLength: 8, maxLength: 140, example: '¿Cómo hago un degradado sin escalones?' })
  @Transform(trim)
  @IsString()
  @Length(8, 140)
  title!: string;

  @ApiProperty({ minLength: 1, maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @Length(1, 5000)
  body!: string;
}

export class UpdateThreadDto {
  @ApiPropertyOptional({ minLength: 8, maxLength: 140 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(8, 140)
  title?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 5000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 5000)
  body?: string;
}

export class ThreadSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  categoryId!: string;

  @ApiProperty()
  categoryName!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ description: 'Primeros 200 caracteres.' })
  excerpt!: string;

  @ApiProperty({ type: ForumAuthorDto })
  author!: ForumAuthorDto;

  @ApiProperty()
  replyCount!: number;

  @ApiProperty({ description: 'Tiene una respuesta marcada como la mejor.' })
  solved!: boolean;

  @ApiProperty()
  pinned!: boolean;

  @ApiProperty({ description: 'Cerrado por soporte: no admite respuestas.' })
  locked!: boolean;

  @ApiProperty({ format: 'date-time' })
  lastActivityAt!: Date;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class ThreadPageDto {
  @ApiProperty({ type: [ThreadSummaryDto] })
  items!: ThreadSummaryDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class ThreadDto extends ThreadSummaryDto {
  @ApiProperty()
  body!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  solutionReplyId!: string | null;

  @ApiProperty({ description: 'Quien mira es el autor (puede editar, borrar y marcar la mejor).' })
  isMine!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  editedAt!: Date | null;
}

// ───────────── Respuestas ─────────────

export class RepliesQueryDto {
  @ApiPropertyOptional({
    enum: REPLY_SORTS,
    default: 'oldest',
    description: 'La mejor respuesta siempre va primero.',
  })
  @IsOptional()
  @IsIn(REPLY_SORTS)
  sort?: (typeof REPLY_SORTS)[number];

  @ApiPropertyOptional({ description: 'Valor de nextCursor (opaco).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class CreateReplyDto {
  @ApiProperty({ minLength: 1, maxLength: 3000 })
  @Transform(trim)
  @IsString()
  @Length(1, 3000)
  body!: string;
}

export class ReplyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  threadId!: string;

  @ApiProperty({ type: ForumAuthorDto })
  author!: ForumAuthorDto;

  @ApiProperty()
  body!: string;

  @ApiProperty({ description: 'Votos "me sirvió".' })
  helpful!: number;

  @ApiProperty({ description: 'Quien mira votó "me sirvió".' })
  votedHelpful!: boolean;

  @ApiProperty({ description: 'Es la mejor respuesta del hilo.' })
  isSolution!: boolean;

  @ApiProperty()
  isMine!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  editedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class ReplyPageDto {
  @ApiProperty({ type: [ReplyDto] })
  items!: ReplyDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class SolutionDto {
  @ApiProperty({ format: 'uuid', description: 'Respuesta del hilo que resolvió la duda.' })
  @IsUUID()
  replyId!: string;
}

// ───────────── Moderación ─────────────

export class ModerateThreadDto {
  @ApiPropertyOptional({ description: 'Fijar arriba del tema.' })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ description: 'Cerrar: no admite respuestas nuevas.' })
  @IsOptional()
  @IsBoolean()
  locked?: boolean;

  @ApiPropertyOptional({ description: 'Retirar (o restaurar) sin esperar reportes.' })
  @IsOptional()
  @IsBoolean()
  removed?: boolean;

  @ApiPropertyOptional({ format: 'uuid', description: 'Mover a otro tema.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class AdminThreadsQueryDto {
  @ApiPropertyOptional({
    enum: ['ALL', 'REPORTED', 'HIDDEN', 'REMOVED'],
    default: 'ALL',
    description:
      'REPORTED: con reportes abiertos; HIDDEN: ocultos por reportes; REMOVED: retirados.',
  })
  @IsOptional()
  @IsIn(['ALL', 'REPORTED', 'HIDDEN', 'REMOVED'])
  state?: 'ALL' | 'REPORTED' | 'HIDDEN' | 'REMOVED';

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  q?: string;
}

export class AdminThreadDto extends ThreadSummaryDto {
  @ApiProperty({ enum: ['VISIBLE', 'HIDDEN', 'REMOVED', 'DELETED'] })
  state!: 'VISIBLE' | 'HIDDEN' | 'REMOVED' | 'DELETED';

  @ApiProperty({ description: 'Reportes abiertos.' })
  reportCount!: number;
}

export class UpdateReplyDto extends CreateReplyDto {}
