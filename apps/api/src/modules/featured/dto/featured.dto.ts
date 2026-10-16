import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Fase 13: destacar una barbería en la búsqueda por un periodo (sin cobro por ahora). */
export class CreateFeaturedDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  barbershopId!: string;

  @ApiPropertyOptional({ description: 'Por defecto, ahora.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @ApiProperty({ description: 'Fin del destacado (máximo 365 días después del inicio).' })
  @Type(() => Date)
  @IsDate()
  endsAt!: Date;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 100, description: 'Mayor primero.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @ApiPropertyOptional({ maxLength: 300, description: 'Nota interna (por qué se destaca).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  note?: string;
}

export class FeaturedQueryDto {
  @ApiPropertyOptional({ description: 'true incluye los terminados y retirados.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  includePast?: boolean;
}

export class FeaturedListingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty({ type: String, nullable: true })
  barbershopName!: string | null;

  @ApiProperty()
  startsAt!: Date;

  @ApiProperty()
  endsAt!: Date;

  @ApiProperty()
  priority!: number;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ enum: ['SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED'] })
  status!: 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';

  @ApiProperty()
  createdAt!: Date;
}
