import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
  IsUUID,
  IsString,
  MaxLength,
} from 'class-validator';
import { StyleRefDto } from '../../barbers/dto/barber.dto';
import { FACE_SHAPES, type FaceShape } from '../face-shape';

export const HAIR_TYPES = ['STRAIGHT', 'WAVY', 'CURLY', 'COILY'] as const;
export const VIBES = ['CLASSIC', 'MODERN'] as const;
export const MAINTENANCE = ['LOW', 'MEDIUM', 'HIGH'] as const;

/** Cuatro medidas de la cara (cualquier unidad: solo cuentan sus proporciones). Nunca la foto. */
export class FaceMeasurementsDto {
  @ApiProperty({ description: 'Largo: de la frente (línea del cabello) al mentón.' })
  @IsNumber()
  @Min(0.0001)
  @Max(100000)
  faceLength!: number;

  @ApiProperty({ description: 'Ancho de la frente.' })
  @IsNumber()
  @Min(0.0001)
  @Max(100000)
  foreheadWidth!: number;

  @ApiProperty({ description: 'Ancho entre pómulos (lo más ancho de la cara media).' })
  @IsNumber()
  @Min(0.0001)
  @Max(100000)
  cheekboneWidth!: number;

  @ApiProperty({ description: 'Ancho de la mandíbula a la altura de sus ángulos.' })
  @IsNumber()
  @Min(0.0001)
  @Max(100000)
  jawWidth!: number;
}

export class FaceShapeAlternativeDto {
  @ApiProperty({ enum: FACE_SHAPES, enumName: 'FaceShape' })
  shape!: FaceShape;

  @ApiProperty()
  probability!: number;
}

export class FaceShapeResultDto {
  @ApiProperty({ enum: FACE_SHAPES, enumName: 'FaceShape' })
  shape!: FaceShape;

  @ApiProperty({ description: 'Probabilidad de la forma elegida (0 a 1).' })
  confidence!: number;

  @ApiProperty({
    type: [FaceShapeAlternativeDto],
    description: 'Formas también posibles (caras mixtas). Muéstralas como "también podría ser".',
  })
  alternatives!: FaceShapeAlternativeDto[];
}

export class RecommendHaircutsDto {
  @ApiPropertyOptional({
    enum: FACE_SHAPES,
    enumName: 'FaceShape',
    description: 'Forma ya conocida (por ejemplo, la guardada). Si no, envía `measurements`.',
  })
  @IsOptional()
  @IsIn(FACE_SHAPES)
  faceShape?: FaceShape;

  @ApiPropertyOptional({ type: FaceMeasurementsDto, description: 'Se clasifican y no se guardan.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => FaceMeasurementsDto)
  measurements?: FaceMeasurementsDto;

  @ApiPropertyOptional({ enum: HAIR_TYPES, enumName: 'HairType' })
  @IsOptional()
  @IsIn(HAIR_TYPES)
  hairType?: (typeof HAIR_TYPES)[number];

  @ApiPropertyOptional({ enum: VIBES, enumName: 'StyleVibe', description: 'Clásico o moderno.' })
  @IsOptional()
  @IsIn(VIBES)
  vibe?: (typeof VIBES)[number];

  @ApiPropertyOptional({
    enum: MAINTENANCE,
    enumName: 'MaintenanceLevel',
    description: 'Mantenimiento que prefiere (LOW: lo mínimo).',
  })
  @IsOptional()
  @IsIn(MAINTENANCE)
  maintenance?: (typeof MAINTENANCE)[number];

  @ApiProperty({ description: 'Ubicación del cliente (solo para esta petición; no se guarda).' })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsLongitude()
  lng!: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 50,
    description: 'Radio (km); por defecto el de la búsqueda.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50)
  radiusKm?: number;
}

export class RecommendedPhotoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  thumbUrl!: string;

  @ApiProperty()
  largeUrl!: string;

  @ApiProperty({ type: String, nullable: true, enum: FACE_SHAPES })
  faceShape!: FaceShape | null;

  @ApiProperty({ description: 'De una cara de la misma forma que la del cliente.' })
  sameFaceShape!: boolean;

  @ApiProperty({ description: 'Etiqueta confirmada por el barbero.' })
  confirmed!: boolean;

  @ApiProperty({ description: 'Foto de demostración (stock): muéstrala como "Ejemplo".' })
  isDemo!: boolean;

  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  barberProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  barberName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Para "reservar este corte".',
  })
  serviceId!: string | null;

  @ApiProperty({ description: 'Metros hasta la barbería (redondeados).' })
  distanceMeters!: number;
}

export class RankedStyleBarberDto {
  @ApiProperty({ format: 'uuid' })
  barberProfileId!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty({ format: 'uuid', description: 'Vínculo en esa barbería (para reservar con él).' })
  barberId!: string;

  @ApiProperty()
  distanceMeters!: number;

  @ApiProperty({ description: 'Trabajos confirmados de este corte.' })
  confirmedWorks!: number;

  @ApiProperty({ description: 'De ellos, en caras de la misma forma que la del cliente.' })
  sameShapeWorks!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Estrellas en este corte (null sin valoraciones).',
  })
  styleRatingAverage!: number | null;

  @ApiProperty()
  styleRatingCount!: number;

  @ApiProperty({ description: 'Puntaje combinado (0 a 1).' })
  score!: number;

  @ApiProperty({ example: '23 trabajos de este corte en caras ovaladas · 4,9 ★ · a 1,2 km' })
  summary!: string;
}

export class RecommendedHaircutDto {
  @ApiProperty({ type: StyleRefDto })
  style!: StyleRefDto;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: MAINTENANCE })
  maintenance!: string | null;

  @ApiProperty({
    description: 'Compatibilidad con la forma de cara (0 a 100), ya ajustada a sus preferencias.',
  })
  compatibility!: number;

  @ApiProperty({ type: String, nullable: true, description: 'Por qué se recomienda.' })
  reason!: string | null;

  @ApiProperty({ description: 'false: la regla aún no fue validada por barberos.' })
  ruleValidated!: boolean;

  @ApiProperty({
    type: [RecommendedPhotoDto],
    description: 'Fotos reales cerca, primero de caras parecidas.',
  })
  photos!: RecommendedPhotoDto[];

  @ApiProperty({
    type: [RankedStyleBarberDto],
    description: 'Mejores barberos de este corte cerca.',
  })
  barbers!: RankedStyleBarberDto[];
}

export class HaircutRecommendationDto {
  @ApiProperty({ type: FaceShapeResultDto })
  faceShape!: FaceShapeResultDto;

  @ApiProperty({ type: [RecommendedHaircutDto] })
  haircuts!: RecommendedHaircutDto[];

  @ApiProperty({
    description: 'Texto obligatorio en la pantalla: es una recomendación, no una regla.',
    example:
      'La forma de cara es una aproximación y muchas caras son mixtas: tómalo como una sugerencia.',
  })
  disclaimer!: string;
}

// ───────────── Etapa 2: caras parecidas e interacciones ─────────────

export class SimilarFacesDto {
  @ApiProperty({
    type: FaceMeasurementsDto,
    description: 'Medidas tomadas en el teléfono (no se guardan).',
  })
  @ValidateNested()
  @Type(() => FaceMeasurementsDto)
  measurements!: FaceMeasurementsDto;

  @ApiProperty()
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsLongitude()
  lng!: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50)
  radiusKm?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 30, default: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(30)
  limit?: number;
}

export class SimilarFacePhotoDto extends RecommendedPhotoDto {
  @ApiProperty({ description: 'Parecido de la cara de la foto con la del cliente (0 a 1).' })
  similarity!: number;

  @ApiProperty({ type: [String], description: 'Claves de los cortes de la foto.' })
  styleKeys!: string[];
}

export const INTERACTION_KINDS = ['VIEW', 'SAVE', 'BOOK'] as const;

export class StyleInteractionDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Foto vista o guardada.' })
  @IsOptional()
  @IsUUID()
  imageId?: string;

  @ApiPropertyOptional({ description: 'Clave del corte.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  styleKey?: string;

  @ApiProperty({ enum: INTERACTION_KINDS })
  @IsIn(INTERACTION_KINDS)
  kind!: (typeof INTERACTION_KINDS)[number];
}
