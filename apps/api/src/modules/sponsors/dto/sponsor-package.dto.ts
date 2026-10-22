import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
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
} from 'class-validator';
import { AUDIENCES } from './sponsor.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class SponsorPackageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'crecimiento' })
  code!: string;

  @ApiProperty({ example: 'Crecimiento' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ description: 'Céntimos.', example: 150000 })
  priceAmount!: number;

  @ApiProperty({ example: 'PEN' })
  currency!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Impresiones incluidas (null: sin tope).',
  })
  impressionsLimit!: number | null;

  @ApiProperty({ description: 'Anuncios (espacios) que admite la campaña.' })
  placementsLimit!: number;

  @ApiProperty({ description: 'Días que dura la campaña desde el pago.' })
  durationDays!: number;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;
}

export class CreateSponsorPackageDto {
  @ApiProperty({ example: 'crecimiento' })
  @Transform(trim)
  @Matches(/^[a-z0-9_]{2,40}$/)
  code!: string;

  @ApiProperty({ example: 'Crecimiento' })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ description: 'Céntimos.' })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  priceAmount!: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  impressionsLimit?: number | null;

  @ApiProperty({ minimum: 1, maximum: 20 })
  @IsInt()
  @Min(1)
  @Max(20)
  placementsLimit!: number;

  @ApiProperty({ minimum: 1, maximum: 365 })
  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class UpdateSponsorPackageDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({ description: 'Solo para compras nuevas.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  priceAmount?: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  impressionsLimit?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  placementsLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  durationDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreatePackagePurchaseDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  packageId!: string;

  @ApiProperty({ description: 'Nombre de la campaña que se creará.' })
  @Transform(trim)
  @IsString()
  @Length(3, 80)
  campaignName!: string;

  @ApiPropertyOptional({ enum: AUDIENCES, default: 'ALL' })
  @IsOptional()
  @IsIn(AUDIENCES)
  audience?: (typeof AUDIENCES)[number];

  @ApiProperty({ description: 'Correo al que se envía el enlace de pago.' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  payerEmail!: string;
}

export const PURCHASE_STATUSES = ['PENDING', 'PAID', 'CANCELED'] as const;

export class PackagePurchaseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sponsorId!: string;

  @ApiProperty({ type: SponsorPackageDto })
  package!: SponsorPackageDto;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  campaignId!: string | null;

  @ApiProperty()
  priceAmount!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ enum: PURCHASE_STATUSES })
  status!: (typeof PURCHASE_STATUSES)[number];

  @ApiProperty({ type: String, nullable: true, description: 'Enlace de pago (solo PENDING).' })
  checkoutUrl!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  paidAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
