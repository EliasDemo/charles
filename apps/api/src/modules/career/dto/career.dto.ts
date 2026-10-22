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
  Min,
  ValidateIf,
  IsLatitude,
  IsLongitude,
} from 'class-validator';
import { StyleRefDto } from '../../barbers/dto/barber.dto';
import { FACE_SHAPES, type FaceShape } from '../../recommendations/face-shape';
import { LocationDto } from '../../locations/locations';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const bool = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

const CURSOR = /^[A-Za-z0-9_-]+$/;
const emptyNull = ({ value }: { value: unknown }): unknown => (value === '' ? null : value);

// ───────────── Perfil profesional ─────────────

export class UpsertBarberProfileDto {
  @ApiProperty({ minLength: 2, maxLength: 60, example: 'Carlos "El Fade"' })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  displayName!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 80,
    example: 'Especialista en degradados',
  })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  headline?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 600 })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 600)
  bio?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 60 })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(60)
  yearsExperience?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60, example: 'Miraflores' })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  district?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '211101',
    description:
      'Distrito de la lista fija (UBIGEO, ver /locations). Reemplaza a `district` (texto libre).',
  })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Matches(/^[0-9]{6}$/)
  ubigeo?: string | null;

  @ApiPropertyOptional({
    description:
      'Aparece en la búsqueda de barberos para las barberías ("disponible para trabajar").',
  })
  @IsOptional()
  @IsBoolean()
  availableForWork?: boolean;
}

export class SetProfileSpecialtiesDto {
  @ApiProperty({ type: [String], maxItems: 10, description: 'Ids de estilos activos (máximo 10).' })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  styleIds!: string[];
}

export class WorkplaceDto {
  @ApiProperty({ format: 'uuid', description: 'Vínculo (id de barbero en esa barbería).' })
  barberId!: string;

  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty({ enum: ['SHOP', 'INDEPENDENT'] })
  barbershopType!: string;

  @ApiProperty({ description: 'Trabaja ahí actualmente.' })
  current!: boolean;

  @ApiProperty()
  since!: Date;

  @ApiProperty({ type: Date, nullable: true })
  until!: Date | null;
}

export class BarberProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ type: String, nullable: true })
  headline!: string | null;

  @ApiProperty({ type: String, nullable: true })
  bio!: string | null;

  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  yearsExperience!: number | null;

  @ApiProperty({ type: String, nullable: true })
  district!: string | null;

  @ApiProperty({ type: LocationDto, nullable: true, description: 'Distrito de la lista fija.' })
  location!: LocationDto | null;

  @ApiProperty()
  availableForWork!: boolean;

  @ApiProperty({ type: Number, nullable: true, description: 'null sin valoraciones.' })
  ratingAverage!: number | null;

  @ApiProperty()
  ratingCount!: number;

  @ApiProperty({ description: 'Atenciones completadas en toda su carrera en Charles.' })
  attendedCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Puesto en el ranking general (null hasta tener 3 valoraciones).',
  })
  rank!: number | null;

  @ApiProperty({ type: [StyleRefDto] })
  specialties!: StyleRefDto[];

  @ApiProperty({
    type: [WorkplaceDto],
    description: 'Dónde trabaja hoy (y dónde trabajó, en /me).',
  })
  workplaces!: WorkplaceDto[];

  @ApiProperty()
  createdAt!: Date;
}

export class PortfolioItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  thumbUrl!: string;

  @ApiProperty()
  largeUrl!: string;

  @ApiProperty()
  width!: number;

  @ApiProperty()
  height!: number;

  @ApiProperty({ type: String, nullable: true })
  caption!: string | null;

  @ApiProperty({ type: [StyleRefDto] })
  styles!: StyleRefDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Barbería donde se subió (null si la subió el barbero desde su perfil).',
  })
  barbershopName!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: FACE_SHAPES, enumName: 'FaceShape' })
  faceShape!: FaceShape | null;

  @ApiProperty()
  labelConfirmed!: boolean;

  @ApiProperty()
  createdAt!: Date;
}

export class PortfolioPageDto {
  @ApiProperty({ type: [PortfolioItemDto] })
  items!: PortfolioItemDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class PortfolioQueryDto {
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

  @ApiPropertyOptional({ description: 'Clave de estilo (por ejemplo fade_low).' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  style?: string;
}

export class PortfolioUploadDto {
  @ApiProperty({ type: 'string', format: 'binary' })
  // Lo lee multer, no el cuerpo: solo se documenta (y se permite) aquí.
  @IsOptional()
  file?: unknown;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  caption?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Ids de estilos (multipart: repetir el campo o separar con comas).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  styleIds?: string[];

  @ApiProperty({
    description: 'Confirma que la persona fotografiada aceptó que se publique (obligatorio).',
  })
  @Transform(bool)
  @IsBoolean()
  consent!: boolean;

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
  @Transform(emptyNull)
  @ValidateIf((_o, v) => v !== null)
  @IsIn(FACE_SHAPES)
  faceShape?: FaceShape | null;
}

export class ProfileReviewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  rating!: number;

  @ApiProperty({ type: String, nullable: true })
  comment!: string | null;

  @ApiProperty({ description: 'Nombre de usuario del cliente (o "Cuenta eliminada").' })
  clientName!: string;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty()
  serviceName!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ description: 'Me gusta de la comunidad.' })
  likes!: number;

  @ApiProperty({ description: 'Con sesión: si le di me gusta.' })
  likedByMe!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Foto de perfil del autor (null si no tiene).',
  })
  authorPhotoUrl!: string | null;
}

export class ProfileReviewPageDto {
  @ApiProperty({ type: [ProfileReviewDto] })
  items!: ProfileReviewDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

// ───────────── Ranking y búsqueda de barberos ─────────────

export class RankingQueryDto {
  @ApiPropertyOptional({ description: 'Clave de estilo (especialidad).' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  style?: string;

  @ApiPropertyOptional({
    description: 'Distrito (coincidencia parcial, sin tildes ni mayúsculas).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  district?: string;

  @ApiPropertyOptional({ description: 'Nombre del barbero (coincidencia parcial).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  q?: string;

  @ApiPropertyOptional({ description: 'Solo los disponibles para trabajar (para barberías).' })
  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  availableForWork?: boolean;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: 'Desplazamiento (paginación).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  offset?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    example: 'San Roman',
    description: 'Provincia (lista fija; sin tildes ni mayúsculas).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  province?: string;

  @ApiPropertyOptional({ description: 'Con lng: barberos cerca de este punto (y su distancia).' })
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
    default: 20,
    description: 'Radio en km (con lat y lng).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  radiusKm?: number;

  @ApiPropertyOptional({
    enum: ['ranking', 'newest', 'distance'],
    default: 'ranking',
    description: 'distance: el más cercano primero (requiere lat y lng).',
  })
  @IsOptional()
  @IsIn(['ranking', 'newest', 'distance'])
  sort?: 'ranking' | 'newest' | 'distance';
}

export class RankedBarberDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Puesto (null si aún no entra al ranking).',
  })
  rank!: number | null;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ type: String, nullable: true })
  headline!: string | null;

  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  district!: string | null;

  @ApiProperty({ type: LocationDto, nullable: true, description: 'Distrito de la lista fija.' })
  location!: LocationDto | null;

  @ApiProperty({ type: Number, nullable: true })
  ratingAverage!: number | null;

  @ApiProperty()
  ratingCount!: number;

  @ApiProperty()
  attendedCount!: number;

  @ApiProperty({ description: 'Puntaje del ranking (promedio bayesiano, 0 a 5).' })
  score!: number;

  @ApiProperty()
  availableForWork!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Km desde el punto pedido (lat/lng): su barbería actual o el centro de su distrito.',
  })
  distanceKm!: number | null;

  @ApiProperty({ type: [StyleRefDto] })
  specialties!: StyleRefDto[];

  @ApiProperty({ type: [String], description: 'Barberías donde trabaja hoy.' })
  currentBarbershops!: string[];
}

export class RankingPageDto {
  @ApiProperty({ type: [RankedBarberDto] })
  items!: RankedBarberDto[];

  @ApiProperty({ type: Number, nullable: true, description: 'offset de la página siguiente.' })
  nextOffset!: number | null;
}
