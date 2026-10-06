import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDivisibleBy,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MoneyDto } from '../../barbershops/dto/barbershop.dto';

/** CLAUDE.md §4.1: sin servicios gratuitos; duración de 5 a 480 minutos en múltiplos de 5. */
export const SERVICE_RULES = {
  minPriceAmount: 1,
  /** Tope de sanidad: S/ 100 000 (en céntimos). */
  maxPriceAmount: 10_000_000,
  minDuration: 5,
  maxDuration: 480,
  durationStep: 5,
} as const;

/** El MVP opera solo en Perú (CLAUDE.md §4.1). */
export const SERVICE_CURRENCY = 'PEN';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const emptyToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? null : trim({ value });

/** Clave estable de una categoría de servicio (por ejemplo `haircut`). */
export const CATEGORY_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/** RF-SER-001. Moneda fija: PEN. */
export class CreateServiceDto {
  @ApiProperty({ example: 'Corte clásico' })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiProperty({ example: 2500, description: 'Precio en céntimos de PEN (mayor que 0).' })
  @IsInt()
  @Min(SERVICE_RULES.minPriceAmount)
  @Max(SERVICE_RULES.maxPriceAmount)
  priceAmount!: number;

  @ApiProperty({ example: 30, description: 'De 5 a 480 minutos, en múltiplos de 5.' })
  @IsInt()
  @Min(SERVICE_RULES.minDuration)
  @Max(SERVICE_RULES.maxDuration)
  @IsDivisibleBy(SERVICE_RULES.durationStep)
  durationMinutes!: number;

  @ApiProperty({
    example: 'haircut',
    description: 'Clave de una categoría activa (GET /service-categories).',
  })
  @IsString()
  @Matches(CATEGORY_KEY_PATTERN)
  categoryKey!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

/** RF-SER-002. No altera reservas ya confirmadas: guardan copia del nombre, la duración y el precio. */
export class UpdateServiceDto extends PartialType(CreateServiceDto) {}

export class ServiceCategoryDto {
  @ApiProperty({ example: 'haircut' })
  key!: string;

  @ApiProperty({ example: 'Corte de cabello' })
  name!: string;
}

export class ServiceCategoryListDto {
  @ApiProperty({ type: [ServiceCategoryDto], description: 'Categorías activas, en orden.' })
  items!: ServiceCategoryDto[];
}

export class ServicePublicDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ type: MoneyDto })
  price!: MoneyDto;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty({ type: ServiceCategoryDto })
  category!: ServiceCategoryDto;
}

export class ServiceManageDto extends ServicePublicDto {
  @ApiProperty()
  isAvailable!: boolean;

  @ApiProperty({ type: [String], description: 'Barberos que realizan el servicio.' })
  barberIds!: string[];
}

export class ServicePublicPageDto {
  @ApiProperty({ type: [ServicePublicDto] })
  items!: ServicePublicDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class ServiceManagePageDto {
  @ApiProperty({ type: [ServiceManageDto] })
  items!: ServiceManageDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
