import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BarbershopStatus, BarbershopType } from '../../../generated/prisma/enums';
import { MoneyDto, PERU_BOUNDS } from '../../barbershops/dto/barbershop.dto';
import { CATEGORY_KEY_PATTERN } from '../../services/dto/service.dto';
import type { SearchSort } from '../ranking/ranking';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Tope de validación; el tope efectivo es `search.max_page_size`. */
export const PAGE_SIZE_HARD_LIMIT = 100;
export const SEARCH_SORTS: SearchSort[] = ['distance', 'rating', 'price'];

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
/** Query string → booleano estricto ("true"/"false"); otro valor no pasa la validación. */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** Punto de búsqueda. Solo se usa en la consulta: no se guarda ni se registra en logs. */
class LocationQueryDto {
  @ApiPropertyOptional({
    example: -12.12,
    description: 'Latitud del punto de búsqueda (con lng). No se guarda ni se registra.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(PERU_BOUNDS.minLat)
  @Max(PERU_BOUNDS.maxLat)
  lat?: number;

  @ApiPropertyOptional({ example: -77.03, description: 'Longitud del punto (con lat).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(PERU_BOUNDS.minLng)
  @Max(PERU_BOUNDS.maxLng)
  lng?: number;
}

/** RF-BUS-001…003. */
export class SearchQueryDto extends LocationQueryDto {
  @ApiPropertyOptional({
    description: 'Radio en km (requiere ubicación). Por defecto 5; se recorta al máximo (25).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.1)
  @Max(1000)
  radiusKm?: number;

  @ApiPropertyOptional({
    description: 'Texto (2–80): nombre de la barbería o de un servicio. Sin tildes ni mayúsculas.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  q?: string;

  @ApiPropertyOptional({ example: 'haircut', description: 'Clave de categoría de servicio.' })
  @IsOptional()
  @IsString()
  @Matches(CATEGORY_KEY_PATTERN)
  category?: string;

  @ApiPropertyOptional({ description: 'Precio mínimo en céntimos (algún servicio en el rango).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  minPrice?: number;

  @ApiPropertyOptional({ description: 'Precio máximo en céntimos.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  maxPrice?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 5,
    description: 'Valoración mínima. Excluye las barberías sin valoraciones.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(5)
  minRating?: number;

  @ApiPropertyOptional({ enum: BarbershopType, enumName: 'BarbershopType' })
  @IsOptional()
  @IsIn(Object.values(BarbershopType))
  type?: BarbershopType;

  @ApiPropertyOptional({ description: 'Solo barberías abiertas en este momento.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  openNow?: boolean;

  @ApiPropertyOptional({
    description: 'Solo barberías con un turno que empieza dentro de la ventana "ahora".',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  availableNow?: boolean;

  @ApiPropertyOptional({
    example: '2030-01-07',
    description: 'Solo barberías con algún turno en esa fecha local (dentro del horizonte).',
  })
  @IsOptional()
  @Matches(LOCAL_DATE)
  date?: string;

  @ApiPropertyOptional({
    enum: SEARCH_SORTS,
    description: 'Por defecto: distance con ubicación; rating sin ella.',
  })
  @IsOptional()
  @IsIn(SEARCH_SORTS)
  sort?: SearchSort;

  @ApiPropertyOptional({ minimum: 1, description: 'Por defecto 20; tope 50.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGE_SIZE_HARD_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: 'Valor de nextCursor de la página anterior (opaco).' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(BASE64URL)
  cursor?: string;
}

/** RF-BUS-004. */
export class AlternativesQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Servicio consultado (define la categoría).' })
  @IsUUID()
  serviceId!: string;

  @ApiPropertyOptional({
    example: '2030-01-07',
    description: 'Fecha local. Por defecto, hoy en la zona de la barbería consultada.',
  })
  @IsOptional()
  @Matches(LOCAL_DATE)
  date?: string;
}

// ───────────── Respuestas ─────────────

export class SearchRatingDto {
  @ApiProperty({ nullable: true, type: Number, description: 'null si no tiene valoraciones.' })
  average!: number | null;

  @ApiProperty()
  count!: number;
}

export class SearchResultDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: BarbershopType, enumName: 'BarbershopType' })
  type!: BarbershopType;

  @ApiProperty({ enum: BarbershopStatus, enumName: 'BarbershopStatus' })
  status!: BarbershopStatus;

  @ApiProperty()
  address!: string;

  @ApiProperty()
  latitude!: number;

  @ApiProperty()
  longitude!: number;

  @ApiProperty({ type: SearchRatingDto })
  rating!: SearchRatingDto;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Distancia al punto de búsqueda, en metros redondeados (null sin ubicación).',
  })
  distanceMeters!: number | null;

  @ApiProperty({
    type: MoneyDto,
    nullable: true,
    description: 'Precio más bajo entre los servicios que cumplen los filtros.',
  })
  priceFrom!: MoneyDto | null;

  @ApiProperty()
  isOpenNow!: boolean;

  @ApiProperty({ description: 'Hay un turno que empieza dentro de la ventana "ahora".' })
  availableNow!: boolean;

  @ApiProperty({ description: 'Resultado destacado (pagado). Hoy siempre false (Fase 13).' })
  featured!: boolean;

  @ApiProperty({
    example: 'America/Lima',
    description: 'Zona IANA de la barbería: sus horas (turnos, horario) se muestran en esta zona.',
  })
  timezone!: string;

  @ApiProperty({
    description: 'Fase 11: si es favorita de la cuenta que consulta. Sin sesión, siempre false.',
  })
  isFavorite!: boolean;
}

export class SearchPageDto {
  @ApiProperty({ type: [SearchResultDto] })
  items!: SearchResultDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;

  @ApiProperty({
    description:
      'true si se alcanzó el tope de barberías evaluadas por petición antes de llenar la página ' +
      '(filtros de disponibilidad). Puede haber más resultados con nextCursor.',
  })
  evaluationLimitReached!: boolean;
}

export class AlternativeSlotDto {
  @ApiProperty()
  startAt!: Date;

  @ApiProperty()
  endAt!: Date;
}

export class AlternativeServiceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: MoneyDto })
  price!: MoneyDto;

  @ApiProperty()
  durationMinutes!: number;
}

export class AlternativeDto {
  @ApiProperty({ type: SearchResultDto })
  barbershop!: SearchResultDto;

  @ApiProperty({ type: AlternativeServiceDto, description: 'Servicio de la misma categoría.' })
  service!: AlternativeServiceDto;

  @ApiProperty({ type: AlternativeSlotDto, description: 'Primer turno disponible en la fecha.' })
  firstSlot!: AlternativeSlotDto;
}

export class AlternativesDto {
  @ApiProperty({ example: '2030-01-07' })
  date!: string;

  @ApiProperty({ example: 'haircut' })
  categoryKey!: string;

  @ApiProperty({ type: [AlternativeDto], description: 'Hasta 5, más cercanas primero.' })
  items!: AlternativeDto[];
}
