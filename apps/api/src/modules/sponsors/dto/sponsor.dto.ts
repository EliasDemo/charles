import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Espacios publicitarios (Fase 13). Los tres primeros son de clientes; el último, de barberías. */
export const SLOT_KEYS = [
  'home_banner',
  'search_top',
  'booking_success',
  'shop_dashboard',
] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];
export const AUDIENCES = ['CLIENTS', 'BARBERSHOPS', 'ALL'] as const;
export const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'] as const;

/** Enlaces solo https (o rutas internas de la app, `charles://`). */
const LINK = { protocols: ['https'], require_protocol: true };

// ───────────── Auspiciadores ─────────────

export class CreateSponsorDto {
  @ApiProperty({ minLength: 2, maxLength: 80 })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiPropertyOptional({ maxLength: 200, description: 'Contacto interno (se guarda cifrado).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  contact?: string;

  @ApiPropertyOptional({ description: 'URL devuelta por POST /admin/sponsors/media.' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  logoUrl?: string;
}

export class UpdateSponsorDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  contact?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @Length(1, 500)
  logoUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SponsorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Solo en /admin.' })
  contact!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  campaigns!: number;

  @ApiProperty()
  products!: number;

  @ApiProperty()
  createdAt!: Date;
}

export class SponsorMediaDto {
  @ApiProperty({ description: 'Imagen grande (1600 px de ancho).' })
  url!: string;

  @ApiProperty({ description: 'Miniatura (400 px de ancho).' })
  thumbUrl!: string;
}

// ───────────── Campañas ─────────────

export class CreateCampaignDto {
  @ApiProperty({ minLength: 2, maxLength: 80 })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiProperty()
  @Type(() => Date)
  @IsDate()
  startsAt!: Date;

  @ApiProperty()
  @Type(() => Date)
  @IsDate()
  endsAt!: Date;

  @ApiPropertyOptional({ enum: AUDIENCES, default: 'ALL' })
  @IsOptional()
  @IsIn(AUDIENCES)
  audience?: (typeof AUDIENCES)[number];
}

export class UpdateCampaignDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;

  @ApiPropertyOptional({ enum: AUDIENCES })
  @IsOptional()
  @IsIn(AUDIENCES)
  audience?: (typeof AUDIENCES)[number];

  @ApiPropertyOptional({
    enum: CAMPAIGN_STATUSES,
    description: 'DRAFT → ACTIVE (publicar), ACTIVE ↔ PAUSED, cualquiera → ENDED (definitivo).',
  })
  @IsOptional()
  @IsIn(CAMPAIGN_STATUSES)
  status?: (typeof CAMPAIGN_STATUSES)[number];
}

export class CreatePlacementDto {
  @ApiProperty({ enum: SLOT_KEYS })
  @IsIn(SLOT_KEYS)
  slotKey!: SlotKey;

  @ApiProperty({ minLength: 2, maxLength: 80 })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  title!: string;

  @ApiPropertyOptional({ description: 'URL devuelta por POST /admin/sponsors/media.' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Enlace https al tocar el anuncio.' })
  @IsOptional()
  @IsUrl(LINK)
  @Length(1, 500)
  actionUrl?: string;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;
}

export class UpdatePlacementDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  title?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @Length(1, 500)
  imageUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsUrl(LINK)
  @Length(1, 500)
  actionUrl?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;
}

export class PlacementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: SLOT_KEYS })
  slotKey!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  imageUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  actionUrl!: string | null;

  @ApiProperty()
  priority!: number;
}

export class CampaignDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sponsorId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  startsAt!: Date;

  @ApiProperty()
  endsAt!: Date;

  @ApiProperty({ enum: AUDIENCES })
  audience!: (typeof AUDIENCES)[number];

  @ApiProperty({ enum: CAMPAIGN_STATUSES })
  status!: (typeof CAMPAIGN_STATUSES)[number];

  @ApiProperty({ description: 'ACTIVE y dentro de sus fechas: se está mostrando.' })
  live!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Fase 15: impresiones del paquete comprado (null: sin tope).',
  })
  impressionsLimit!: number | null;

  @ApiProperty({ description: 'Impresiones contadas (una por persona y hora).' })
  impressionsCount!: number;

  @ApiProperty({ type: [PlacementDto] })
  placements!: PlacementDto[];

  @ApiProperty()
  createdAt!: Date;
}

export class PlacementMetricsDto {
  @ApiProperty({ format: 'uuid' })
  placementId!: string;

  @ApiProperty()
  slotKey!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ description: 'Impresiones (una por persona o dispositivo por hora).' })
  impressions!: number;

  @ApiProperty()
  clicks!: number;

  @ApiProperty({ description: 'Clics / impresiones (0 a 1).' })
  ctr!: number;
}

export class CampaignMetricsDto {
  @ApiProperty({ format: 'uuid' })
  campaignId!: string;

  @ApiProperty()
  impressions!: number;

  @ApiProperty()
  clicks!: number;

  @ApiProperty()
  ctr!: number;

  @ApiProperty({ type: [PlacementMetricsDto] })
  placements!: PlacementMetricsDto[];
}

// ───────────── Productos ─────────────

export class CreateProductDto {
  @ApiProperty({ minLength: 2, maxLength: 80 })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 500)
  imageUrl?: string;

  @ApiProperty({ description: 'Enlace https de compra (Charles no vende ni cobra).' })
  @IsUrl(LINK)
  @Length(1, 500)
  actionUrl!: string;

  @ApiPropertyOptional({ maxLength: 40, example: 'Desde S/ 39.90' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  priceText?: string;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class UpdateProductDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @Length(1, 500)
  imageUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl(LINK)
  @Length(1, 500)
  actionUrl?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  priceText?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000 })
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

export class ProductDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sponsorId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  imageUrl!: string | null;

  @ApiProperty()
  actionUrl!: string;

  @ApiProperty({ type: String, nullable: true })
  priceText!: string | null;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;
}

// ───────────── Público (app) ─────────────

export class PlacementsQueryDto {
  @ApiProperty({ enum: SLOT_KEYS })
  @IsIn(SLOT_KEYS)
  slot!: SlotKey;
}

export class PublicPlacementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  imageUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  actionUrl!: string | null;

  @ApiProperty({ format: 'uuid' })
  sponsorId!: string;

  @ApiProperty()
  sponsorName!: string;

  @ApiProperty({ type: String, nullable: true })
  sponsorLogoUrl!: string | null;
}

export class PlacementEventDto {
  @ApiProperty({ enum: ['IMPRESSION', 'CLICK'] })
  @IsIn(['IMPRESSION', 'CLICK'])
  type!: 'IMPRESSION' | 'CLICK';

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sin sesión: identificador aleatorio de la instalación (UUID que la app genera una vez y ' +
      'guarda). Con sesión se ignora. Nunca se guarda en claro.',
  })
  @IsOptional()
  @IsUUID()
  viewerKey?: string;
}

export class PublicSponsorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: [ProductDto] })
  products!: ProductDto[];
}
