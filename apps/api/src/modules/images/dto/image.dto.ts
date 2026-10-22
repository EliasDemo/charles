import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
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
import { PaginationQueryDto } from '../../../common/pagination/pagination';
import { StyleRefDto } from '../../barbers/dto/barber.dto';
import { FACE_SHAPES, type FaceShape } from '../../recommendations/face-shape';
import {
  HAIR_TYPES,
  MAINTENANCE as MAINTENANCE_LEVELS,
  VIBES as STYLE_VIBES,
} from '../../recommendations/dto/recommendation.dto';
import { MoneyDto } from '../../barbershops/dto/barbershop.dto';
import { ImageReportReason, ReportStatus } from '../../../generated/prisma/enums';
import { IMAGE_DEFAULTS, STYLE_KEY_PATTERN } from '../image-policy';

const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const emptyToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? null : trim({ value });
/** En multipart los arreglos llegan como texto: "a,b" o campos repetidos. */
const toIdList = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') return value === '' ? [] : value;
  const list: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
  return list
    .flatMap((v): unknown[] => (typeof v === 'string' ? v.split(',') : [v]))
    .map((v): unknown => (typeof v === 'string' ? v.trim() : v))
    .filter((v) => v !== '');
};

// ───────────── Entradas ─────────────

/** Campo de archivo de las subidas (multipart/form-data, campo `file`). */
export class ImageUploadDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'JPEG, PNG o WebP (HEIC: convertir en la app), hasta 10 MB.',
  })
  // Lo lee multer, no el cuerpo: solo se documenta (y se permite) aquí.
  @IsOptional()
  file?: unknown;
}

/** Subida a la galería (multipart/form-data). */
export class GalleryUploadDto extends ImageUploadDto {
  @ApiProperty({
    description:
      'Obligatorio y true: quien sube declara que la persona fotografiada dio su consentimiento.',
  })
  @Transform(toBoolean)
  @IsBoolean()
  @IsIn([true], { message: 'consent debe ser true' })
  consent!: boolean;

  @ApiPropertyOptional({ maxLength: 200, nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(200)
  caption?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'Estilos (hasta 3). En multipart: separados por comas o campo repetido.',
  })
  @IsOptional()
  @Transform(toIdList)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(IMAGE_DEFAULTS.stylesPerImageMax)
  @IsUUID('all', { each: true })
  styleIds?: string[];

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Servicio para "reservar este estilo" desde la foto (de la misma barbería).',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  serviceId?: string | null;

  @ApiPropertyOptional({
    enum: FACE_SHAPES,
    enumName: 'FaceShape',
    nullable: true,
    type: String,
    description:
      'Forma de cara de la persona (la marca el barbero). Con estilos, la foto queda como etiqueta ' +
      'confirmada y sirve para recomendar cortes a caras parecidas.',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsIn(FACE_SHAPES)
  faceShape?: FaceShape | null;

  @ApiPropertyOptional({
    description:
      'Forma de cara, etapa 2: medidas de la cara de la foto tomadas EN EL TELÉFONO (largo, ancho ' +
      'de frente, pómulos y mandíbula, en cualquier unidad). Las cuatro o ninguna. Si no se envía ' +
      'faceShape, se clasifica con ellas (etiqueta sin confirmar). Nunca se envían puntos de la cara.',
  })
  @IsOptional()
  @Type(() => Number)
  @Min(0.0001)
  @Max(100000)
  faceLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @Min(0.0001)
  @Max(100000)
  foreheadWidth?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @Min(0.0001)
  @Max(100000)
  cheekboneWidth?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @Min(0.0001)
  @Max(100000)
  jawWidth?: number;
}

export class UpdateGalleryImageDto {
  @ApiPropertyOptional({ maxLength: 200, nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(200)
  caption?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Reemplaza los estilos (hasta 3).' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(IMAGE_DEFAULTS.stylesPerImageMax)
  @IsUUID('all', { each: true })
  styleIds?: string[];

  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  serviceId?: string | null;

  @ApiPropertyOptional({
    description: `true la destaca (hasta ${IMAGE_DEFAULTS.pinnedMaxPerBarber} por barbero, images.pinned_max_per_barber).`,
  })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({
    enum: FACE_SHAPES,
    enumName: 'FaceShape',
    nullable: true,
    type: String,
    description:
      'Forma de cara de la persona (la marca el barbero). Con estilos, la foto queda como etiqueta ' +
      'confirmada y sirve para recomendar cortes a caras parecidas.',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsIn(FACE_SHAPES)
  faceShape?: FaceShape | null;
}

export class SetSpecialtiesDto {
  @ApiProperty({ type: [String], description: `Estilos (hasta ${IMAGE_DEFAULTS.specialtiesMax}).` })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(IMAGE_DEFAULTS.specialtiesMax)
  @IsUUID('all', { each: true })
  styleIds!: string[];
}

export class GalleryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Solo las fotos de este barbero.' })
  @IsOptional()
  @IsUUID()
  barberId?: string;

  @ApiPropertyOptional({ example: 'fade_low', description: 'Solo las fotos de este estilo.' })
  @IsOptional()
  @IsString()
  @Matches(STYLE_KEY_PATTERN)
  style?: string;
}

export class StylesQueryDto {
  @ApiPropertyOptional({ example: 'haircut', description: 'Solo los estilos de esta categoría.' })
  @IsOptional()
  @IsString()
  @Matches(STYLE_KEY_PATTERN)
  category?: string;
}

export class CreateImageReportDto {
  @ApiProperty({ enum: ImageReportReason, enumName: 'ImageReportReason' })
  @IsIn(Object.values(ImageReportReason))
  reason!: ImageReportReason;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  details?: string;
}

export const IMAGE_MODERATION_DECISIONS = ['KEEP', 'REMOVE', 'RESTORE'] as const;
export type ImageModerationDecision = (typeof IMAGE_MODERATION_DECISIONS)[number];

export class ImageModerationDto {
  @ApiProperty({
    enum: IMAGE_MODERATION_DECISIONS,
    description:
      'KEEP: se mantiene y se cierran los reportes. REMOVE: se retira (no se muestra). RESTORE: vuelve a mostrarse.',
  })
  @IsIn(IMAGE_MODERATION_DECISIONS)
  decision!: ImageModerationDecision;

  @ApiProperty({ minLength: 5, maxLength: 500, description: 'Motivo (queda en la auditoría).' })
  @Transform(trim)
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class ReportedImagesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus, enumName: 'ReportStatus' })
  @IsOptional()
  @IsIn(Object.values(ReportStatus))
  status?: ReportStatus;
}

export class CreateStyleDto {
  @ApiProperty({ example: 'fade_low' })
  @IsString()
  @Matches(STYLE_KEY_PATTERN)
  key!: string;

  @ApiProperty({ example: 'Degradado bajo' })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  name!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300 })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({
    enum: MAINTENANCE_LEVELS,
    enumName: 'MaintenanceLevel',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(MAINTENANCE_LEVELS)
  maintenance?: (typeof MAINTENANCE_LEVELS)[number] | null;

  @ApiPropertyOptional({ enum: HAIR_TYPES, enumName: 'HairType', isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(HAIR_TYPES, { each: true })
  hairTypes?: (typeof HAIR_TYPES)[number][];

  @ApiPropertyOptional({ enum: STYLE_VIBES, enumName: 'StyleVibe', nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(STYLE_VIBES)
  vibe?: (typeof STYLE_VIBES)[number] | null;
}

export class UpdateStyleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'false lo oculta de la app y de la búsqueda (no se borra).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300 })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({
    enum: MAINTENANCE_LEVELS,
    enumName: 'MaintenanceLevel',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(MAINTENANCE_LEVELS)
  maintenance?: (typeof MAINTENANCE_LEVELS)[number] | null;

  @ApiPropertyOptional({ enum: HAIR_TYPES, enumName: 'HairType', isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(HAIR_TYPES, { each: true })
  hairTypes?: (typeof HAIR_TYPES)[number][];

  @ApiPropertyOptional({ enum: STYLE_VIBES, enumName: 'StyleVibe', nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(STYLE_VIBES)
  vibe?: (typeof STYLE_VIBES)[number] | null;
}

// ───────────── Respuestas ─────────────

export class ServiceStyleDto extends StyleRefDto {
  @ApiProperty({ format: 'uuid' })
  categoryId!: string;

  @ApiProperty({ example: 'haircut' })
  categoryKey!: string;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({
    enum: MAINTENANCE_LEVELS,
    enumName: 'MaintenanceLevel',
    nullable: true,
    type: String,
  })
  maintenance!: (typeof MAINTENANCE_LEVELS)[number] | null;

  @ApiProperty({ enum: HAIR_TYPES, enumName: 'HairType', isArray: true })
  hairTypes!: (typeof HAIR_TYPES)[number][];

  @ApiProperty({ enum: STYLE_VIBES, enumName: 'StyleVibe', nullable: true, type: String })
  vibe!: (typeof STYLE_VIBES)[number] | null;
}

export class AdminServiceStyleDto extends ServiceStyleDto {
  @ApiProperty()
  isActive!: boolean;
}

export class BarbershopMediaDto {
  @ApiProperty({ nullable: true, type: String })
  logoUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  coverUrl!: string | null;

  @ApiProperty({ nullable: true, type: String })
  coverThumbUrl!: string | null;
}

export class BarberPhotoDto {
  @ApiProperty({ nullable: true, type: String })
  photoUrl!: string | null;
}

/** Servicio para "reservar este estilo" desde la foto. */
export class GalleryServiceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: MoneyDto })
  price!: MoneyDto;

  @ApiProperty()
  durationMinutes!: number;
}

export class GalleryImageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  barberId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  barberName!: string | null;

  @ApiProperty({ description: 'Miniatura (400 px de ancho, WebP).' })
  thumbUrl!: string;

  @ApiProperty({ description: 'Grande (hasta 1600 px de ancho, WebP).' })
  largeUrl!: string;

  @ApiProperty()
  width!: number;

  @ApiProperty()
  height!: number;

  @ApiProperty({ nullable: true, type: String })
  caption!: string | null;

  @ApiProperty({ type: [StyleRefDto] })
  styles!: StyleRefDto[];

  @ApiProperty({
    type: GalleryServiceDto,
    nullable: true,
    description:
      'Solo si el servicio existe y está disponible: la app ofrece "reservar este estilo".',
  })
  service!: GalleryServiceDto | null;

  @ApiProperty({ description: 'Destacada (fijada arriba).' })
  pinned!: boolean;

  @ApiProperty({ type: String, nullable: true, enum: FACE_SHAPES, enumName: 'FaceShape' })
  faceShape!: FaceShape | null;

  @ApiProperty({ description: 'Estilos y forma confirmados por el barbero.' })
  labelConfirmed!: boolean;

  @ApiProperty({ description: 'Foto de demostración (stock): muéstrala como "Ejemplo".' })
  isDemo!: boolean;

  @ApiProperty()
  createdAt!: Date;
}

export class GalleryPageDto {
  @ApiProperty({
    type: [GalleryImageDto],
    description: 'Destacadas: solo en la primera página (sin cursor). No se repiten en items.',
  })
  pinned!: GalleryImageDto[];

  @ApiProperty({ type: [GalleryImageDto], description: 'Resto, las más recientes primero.' })
  items!: GalleryImageDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class GalleryImageManageDto extends GalleryImageDto {
  @ApiProperty({ description: 'Reportes abiertos.' })
  openReports!: number;

  @ApiProperty({
    description:
      'Oculta al público: por reportes (images.report_hide_threshold) o retirada por soporte.',
  })
  hidden!: boolean;

  @ApiProperty({ description: 'Retirada por soporte.' })
  removed!: boolean;
}

export class GalleryManagePageDto {
  @ApiProperty({ type: [GalleryImageManageDto] })
  items!: GalleryImageManageDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class ImageReportViewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ImageReportReason, enumName: 'ImageReportReason' })
  reason!: ImageReportReason;

  @ApiProperty({ nullable: true, type: String })
  details!: string | null;

  @ApiProperty({ enum: ReportStatus, enumName: 'ReportStatus' })
  status!: ReportStatus;

  @ApiProperty()
  createdAt!: Date;
}

export class AdminReportedImageDto extends GalleryImageManageDto {
  @ApiProperty({ type: [ImageReportViewDto] })
  reports!: ImageReportViewDto[];
}

export class AdminReportedImagePageDto {
  @ApiProperty({ type: [AdminReportedImageDto] })
  items!: AdminReportedImageDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
