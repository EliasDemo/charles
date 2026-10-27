import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const POST_TYPES = ['PROMOTION', 'EVENT', 'WORK', 'ANNOUNCEMENT'] as const;
export type PostTypeValue = (typeof POST_TYPES)[number];
export const FEED_TABS = ['forYou', 'nearby', 'following'] as const;
export const ATTENDANCE = ['INTERESTED', 'GOING', 'NONE'] as const;
export const REPORT_TARGETS = ['post', 'comment', 'user', 'forum_thread', 'forum_reply'] as const;
export const REPORT_REASONS = [
  'SPAM',
  'OFFENSIVE',
  'HARASSMENT',
  'NUDITY',
  'VIOLENCE',
  'FALSE_INFO',
  'OTHER',
] as const;
export const MAX_POST_PHOTOS = 10;

// ───────────── Entrada ─────────────

export class PostEventInputDto {
  @ApiProperty({ format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;

  @ApiProperty({ maxLength: 200 })
  @Transform(trim)
  @IsString()
  @Length(3, 200)
  address!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100000,
    description: 'Cupo (personas que van). Sin cupo: ilimitado.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  capacity?: number;
}

export class CreatePostDto {
  @ApiProperty({ enum: POST_TYPES })
  @IsIn(POST_TYPES)
  type!: PostTypeValue;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Publicar como esta barbería (OWNER o MANAGER). Sin él, como mi perfil profesional.',
  })
  @IsOptional()
  @IsUUID()
  barbershopId?: string;

  @ApiProperty({ maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  body!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_POST_PHOTOS,
    description: 'IDs de fotos subidas antes con POST /posts/media (en ese orden).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POST_PHOTOS)
  @IsUUID('all', { each: true })
  mediaIds?: string[];

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'PROMOTION: promoción existente de la barbería.',
  })
  @IsOptional()
  @IsUUID()
  promotionId?: string;

  @ApiPropertyOptional({ type: PostEventInputDto, description: 'Obligatorio en EVENT.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => PostEventInputDto)
  event?: PostEventInputDto;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'WORK: perfil del barbero que hizo el corte.',
  })
  @IsOptional()
  @IsUUID()
  barberProfileId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'WORK: servicio para "reservar este estilo".',
  })
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  commentsDisabled?: boolean;
}

export class UpdatePostDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  body?: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_POST_PHOTOS,
    description: 'Reemplaza las fotos.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POST_PHOTOS)
  @IsUUID('all', { each: true })
  mediaIds?: string[];

  @ApiPropertyOptional({ type: PostEventInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PostEventInputDto)
  event?: PostEventInputDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  commentsDisabled?: boolean;
}

export class PinPostDto {
  @ApiProperty({ description: 'true: fija la publicación arriba en el perfil del autor.' })
  @IsBoolean()
  pinned!: boolean;
}

export class FeedQueryDto {
  @ApiPropertyOptional({ enum: FEED_TABS, default: 'forYou' })
  @IsOptional()
  @IsIn(FEED_TABS)
  tab?: (typeof FEED_TABS)[number];

  @ApiPropertyOptional({ enum: POST_TYPES })
  @IsOptional()
  @IsIn(POST_TYPES)
  type?: PostTypeValue;

  @ApiPropertyOptional({ description: 'nearby: obligatorio (con lng).' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 200,
    default: 30,
    description: 'nearby: radio en km.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  radiusKm?: number;

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

export class AuthorPostsQueryDto {
  @ApiPropertyOptional({ enum: POST_TYPES })
  @IsOptional()
  @IsIn(POST_TYPES)
  type?: PostTypeValue;

  @ApiPropertyOptional()
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

export class CommentsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Respuestas de este comentario. Sin él: primer nivel.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
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

export class CreateCommentDto {
  @ApiProperty({ maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  body!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Comentario de primer nivel al que responde. Para responder a una respuesta, usa su mismo padre y mentionUserId.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Cuenta mencionada (recibe aviso).' })
  @IsOptional()
  @IsUUID()
  mentionUserId?: string;
}

export class UpdateCommentDto {
  @ApiProperty({ maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  body!: string;
}

export class PinCommentDto {
  @ApiProperty()
  @IsBoolean()
  pinned!: boolean;
}

export class AttendanceDto {
  @ApiProperty({ enum: ATTENDANCE })
  @IsIn(ATTENDANCE)
  status!: (typeof ATTENDANCE)[number];
}

export class CreateContentReportDto {
  @ApiProperty({ enum: REPORT_TARGETS })
  @IsIn(REPORT_TARGETS)
  targetType!: (typeof REPORT_TARGETS)[number];

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetId!: string;

  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS)
  reason!: (typeof REPORT_REASONS)[number];

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class SavedPostsQueryDto {
  @ApiPropertyOptional()
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

export class AdminReportsQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'DISMISSED', 'ACTIONED'], default: 'OPEN' })
  @IsOptional()
  @IsIn(['OPEN', 'DISMISSED', 'ACTIONED'])
  status?: 'OPEN' | 'DISMISSED' | 'ACTIONED';

  @ApiPropertyOptional({ enum: ['POST', 'COMMENT', 'USER', 'FORUM_THREAD', 'FORUM_REPLY'] })
  @IsOptional()
  @IsIn(['POST', 'COMMENT', 'USER', 'FORUM_THREAD', 'FORUM_REPLY'])
  targetType?: 'POST' | 'COMMENT' | 'USER' | 'FORUM_THREAD' | 'FORUM_REPLY';
}

export class ResolveReportDto {
  @ApiProperty({
    enum: ['DISMISS', 'REMOVE', 'RESTORE'],
    description:
      'DISMISS: sin infracción (si estaba oculto por reportes, vuelve a verse). REMOVE: retira el contenido. ' +
      'RESTORE: vuelve a mostrar un contenido retirado. En reportes de cuentas, REMOVE no aplica (usar Cuentas).',
  })
  @IsIn(['DISMISS', 'REMOVE', 'RESTORE'])
  action!: 'DISMISS' | 'REMOVE' | 'RESTORE';

  @ApiProperty({ maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  reason!: string;
}

// ───────────── Salida ─────────────

export class PostAuthorDto {
  @ApiProperty({ enum: ['BARBERSHOP', 'PROFESSIONAL'] })
  kind!: 'BARBERSHOP' | 'PROFESSIONAL';

  @ApiProperty({ format: 'uuid', description: 'ID de la barbería o del perfil profesional.' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ description: 'Barbería con insignia "Verificada" de su plan.' })
  verified!: boolean;

  @ApiProperty()
  followers!: number;
}

export class PostMediaDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  url!: string | null;

  @ApiProperty({ type: String, nullable: true })
  thumbUrl!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  width!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height!: number | null;
}

export class PostEventDto {
  @ApiProperty({ format: 'date-time' })
  startsAt!: Date;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  endsAt!: Date | null;

  @ApiProperty()
  address!: string;

  @ApiProperty({ type: Number, nullable: true })
  lat!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lng!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  capacity!: number | null;

  @ApiProperty()
  going!: number;

  @ApiProperty()
  interested!: number;

  @ApiProperty({ description: 'Sin cupo disponible para GOING.' })
  full!: boolean;
}

export class PostPromotionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['PERCENTAGE', 'FIXED_AMOUNT'] })
  type!: string;

  @ApiProperty()
  value!: number;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  endsAt!: Date | null;
}

export class PostCountsDto {
  @ApiProperty()
  likes!: number;

  @ApiProperty()
  comments!: number;

  @ApiProperty()
  shares!: number;
}

export class PostDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: POST_TYPES })
  type!: PostTypeValue;

  @ApiProperty({ type: PostAuthorDto })
  author!: PostAuthorDto;

  @ApiProperty()
  body!: string;

  @ApiProperty({ type: [PostMediaDto] })
  media!: PostMediaDto[];

  @ApiProperty({ type: PostPromotionDto, nullable: true })
  promotion!: PostPromotionDto | null;

  @ApiProperty({ type: PostEventDto, nullable: true })
  event!: PostEventDto | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  barberProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  serviceId!: string | null;

  @ApiProperty({ type: PostCountsDto })
  counts!: PostCountsDto;

  @ApiProperty({ type: Number, nullable: true, description: 'Con lat/lng en el feed.' })
  distanceKm!: number | null;

  @ApiProperty()
  commentsDisabled!: boolean;

  @ApiProperty()
  pinned!: boolean;

  @ApiProperty({ description: 'Enlace para compartir (página web con vista previa).' })
  shareUrl!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  editedAt!: Date | null;

  @ApiProperty({ description: 'Con sesión.' })
  likedByMe!: boolean;

  @ApiProperty()
  savedByMe!: boolean;

  @ApiProperty()
  followingAuthor!: boolean;

  @ApiProperty({ enum: ['INTERESTED', 'GOING', 'NONE'] })
  myEventStatus!: 'INTERESTED' | 'GOING' | 'NONE';

  @ApiProperty()
  canEdit!: boolean;

  @ApiProperty()
  canDelete!: boolean;

  @ApiProperty()
  canPin!: boolean;
}

export class PostPageDto {
  @ApiProperty({ type: [PostDto] })
  items!: PostDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class UploadedPostMediaDto extends PostMediaDto {}

export class CommentAuthorDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ description: 'Nombre de usuario.' })
  username!: string;

  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;
}

export class CommentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  postId!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  parentId!: string | null;

  @ApiProperty({ type: CommentAuthorDto })
  author!: CommentAuthorDto;

  @ApiProperty({
    description: 'Lo escribió el autor de la publicación (la barbería o el barbero).',
  })
  authorIsOfficial!: boolean;

  @ApiProperty({ type: CommentAuthorDto, nullable: true })
  mention!: CommentAuthorDto | null;

  @ApiProperty()
  body!: string;

  @ApiProperty()
  likes!: number;

  @ApiProperty()
  replies!: number;

  @ApiProperty()
  likedByMe!: boolean;

  @ApiProperty()
  pinned!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  editedAt!: Date | null;

  @ApiProperty()
  canEdit!: boolean;

  @ApiProperty({ description: 'Su autor o el autor de la publicación.' })
  canDelete!: boolean;

  @ApiProperty({ description: 'Solo el autor de la publicación (comentarios de primer nivel).' })
  canPin!: boolean;
}

export class CommentPageDto {
  @ApiProperty({ type: [CommentDto] })
  items!: CommentDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class LikeStateDto {
  @ApiProperty()
  liked!: boolean;

  @ApiProperty()
  likes!: number;
}

export class SaveStateDto {
  @ApiProperty()
  saved!: boolean;
}

export class FollowStateDto {
  @ApiProperty()
  following!: boolean;

  @ApiProperty()
  followers!: number;
}

export class AttendanceStateDto {
  @ApiProperty({ enum: ATTENDANCE })
  status!: (typeof ATTENDANCE)[number];

  @ApiProperty()
  going!: number;

  @ApiProperty()
  interested!: number;

  @ApiProperty({ type: Number, nullable: true })
  capacity!: number | null;
}

export class ShareStateDto {
  @ApiProperty()
  shares!: number;

  @ApiProperty()
  shareUrl!: string;
}

export class BlockStateDto {
  @ApiProperty()
  blocked!: boolean;
}

export class BlockedUserDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ format: 'date-time' })
  blockedAt!: Date;
}

export class AdminContentReportDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['POST', 'COMMENT', 'USER', 'FORUM_THREAD', 'FORUM_REPLY'] })
  targetType!: string;

  @ApiProperty({ format: 'uuid' })
  targetId!: string;

  @ApiProperty({ enum: REPORT_REASONS })
  reason!: string;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ enum: ['OPEN', 'DISMISSED', 'ACTIONED'] })
  status!: string;

  @ApiProperty({ description: 'Usuario que reporta.' })
  reporter!: string;

  @ApiProperty({ description: 'Reportes abiertos del mismo objetivo.' })
  openReports!: number;

  @ApiProperty({ description: 'Texto del contenido (o el usuario reportado).' })
  preview!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Autor del contenido (usuario).' })
  targetAuthor!: string | null;

  @ApiProperty({ enum: ['VISIBLE', 'HIDDEN', 'REMOVED', 'DELETED'] })
  targetState!: string;

  @ApiProperty({ type: [String], description: 'Fotos (publicaciones).' })
  photos!: string[];

  @ApiProperty({ type: String, nullable: true })
  resolution!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class PostMediaUploadDto {
  @ApiProperty({ type: 'string', format: 'binary' })
  // Lo lee multer, no el cuerpo: solo se documenta (y se permite) aquí.
  @IsOptional()
  file?: unknown;
}
