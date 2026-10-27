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
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { VideoDto } from '../../videos/dto/video.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Espacios publicitarios. `shop_dashboard` es de la pantalla de la barbería; `store_featured` es el
 * destacado de la Tienda (para el público que se pida); los demás son de clientes.
 */
export const SLOT_KEYS = [
  'home_banner',
  'search_top',
  'booking_success',
  'shop_dashboard',
  'store_featured',
] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];
export const AUDIENCES = ['CLIENTS', 'BARBERSHOPS', 'ALL'] as const;
export const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'] as const;
/** Rubros de la marca: cosmética, máquinas y herramientas, mobiliario, insumos, formación, otro. */
export const SPONSOR_CATEGORIES = [
  'COSMETICS',
  'TOOLS',
  'FURNITURE',
  'SUPPLIES',
  'EDUCATION',
  'OTHER',
] as const;
export type SponsorCategory = (typeof SPONSOR_CATEGORIES)[number];
const COUPON = /^[A-Z0-9-]{3,30}$/;
const upper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

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

  @ApiPropertyOptional({ enum: SPONSOR_CATEGORIES, default: 'OTHER' })
  @IsOptional()
  @IsIn(SPONSOR_CATEGORIES)
  category?: SponsorCategory;

  @ApiPropertyOptional({ maxLength: 600, description: 'Presentación de la marca en la Tienda.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 600)
  description?: string;

  @ApiPropertyOptional({ description: 'Web de la marca (https).' })
  @IsOptional()
  @IsUrl(LINK)
  @Length(1, 500)
  websiteUrl?: string;

  @ApiPropertyOptional({ description: 'Portada (URL devuelta por POST /admin/sponsors/media).' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  coverUrl?: string;
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

  @ApiPropertyOptional({ enum: SPONSOR_CATEGORIES })
  @IsOptional()
  @IsIn(SPONSOR_CATEGORIES)
  category?: SponsorCategory;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 600 })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 600)
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsUrl(LINK)
  @Length(1, 500)
  websiteUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsString()
  @Length(1, 500)
  coverUrl?: string | null;
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

  @ApiProperty({ enum: SPONSOR_CATEGORIES })
  category!: SponsorCategory;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  websiteUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  coverUrl!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  campaigns!: number;

  @ApiProperty()
  products!: number;

  @ApiProperty({ description: 'Videos vigentes (listos o en proceso).' })
  videos!: number;

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

  @ApiPropertyOptional({ enum: AUDIENCES, default: 'ALL' })
  @IsOptional()
  @IsIn(AUDIENCES)
  audience?: (typeof AUDIENCES)[number];

  @ApiPropertyOptional({
    minimum: 100,
    maximum: 10_000_000,
    description: 'Precio normal en céntimos.',
  })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10_000_000)
  priceAmount?: number;

  @ApiPropertyOptional({
    minimum: 100,
    description: 'Precio de oferta en céntimos: exige priceAmount y debe ser menor.',
  })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10_000_000)
  offerPriceAmount?: number;

  @ApiPropertyOptional({
    example: 'CHARLES10',
    description: 'Cupón de la marca (A-Z, 0-9, guion).',
  })
  @IsOptional()
  @Transform(upper)
  @Matches(COUPON)
  couponCode?: string;

  @ApiPropertyOptional({ description: 'Fin de la oferta (sin él, vale mientras exista).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  offerEndsAt?: Date;
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

  @ApiPropertyOptional({ enum: AUDIENCES })
  @IsOptional()
  @IsIn(AUDIENCES)
  audience?: (typeof AUDIENCES)[number];

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Céntimos.' })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(100)
  @Max(10_000_000)
  priceAmount?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Céntimos; null quita la oferta.',
  })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(100)
  @Max(10_000_000)
  offerPriceAmount?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(upper)
  @Matches(COUPON)
  couponCode?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Type(() => Date)
  @IsDate()
  offerEndsAt?: Date | null;
}

/** Producto tal como lo ve la app (sin métricas internas). */
export class PublicProductDto {
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

  @ApiProperty({ description: 'Enlace https a la tienda de la marca (Charles no vende ni cobra).' })
  actionUrl!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Detalle libre: "Frasco de 100 g".' })
  priceText!: string | null;

  @ApiProperty({ enum: AUDIENCES })
  audience!: (typeof AUDIENCES)[number];

  @ApiProperty({ type: Number, nullable: true, description: 'Precio normal en céntimos.' })
  priceAmount!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Precio de oferta en céntimos; null si no hay oferta vigente.',
  })
  offerPriceAmount!: number | null;

  @ApiProperty({ example: 'PEN' })
  currency!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Descuento redondeado (1 a 99).' })
  discountPercent!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Cupón de la marca, si la oferta lo usa.',
  })
  couponCode!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  offerEndsAt!: Date | null;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;
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

  @ApiProperty({ enum: AUDIENCES })
  audience!: (typeof AUDIENCES)[number];

  @ApiProperty({ type: Number, nullable: true })
  priceAmount!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Tal como se cargó (aunque haya vencido).',
  })
  offerPriceAmount!: number | null;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ type: String, nullable: true })
  couponCode!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  offerEndsAt!: Date | null;

  @ApiProperty({ description: 'La oferta está vigente ahora.' })
  offerActive!: boolean;

  @ApiProperty({ type: Number, nullable: true })
  discountPercent!: number | null;

  @ApiProperty({ description: 'Clics a la tienda (uno por persona o dispositivo por hora).' })
  clicks!: number;
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

  @ApiProperty({ enum: SPONSOR_CATEGORIES })
  category!: SponsorCategory;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Web de la marca (https).' })
  websiteUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  coverUrl!: string | null;

  @ApiProperty({ type: [PublicProductDto] })
  products!: PublicProductDto[];

  @ApiProperty({
    type: [VideoDto],
    description: 'Videos de la marca (hasta 30 s, sin sonido al inicio).',
  })
  videos!: VideoDto[];
}

// ───────────── Tienda ─────────────

export class StoreQueryDto {
  @ApiPropertyOptional({
    enum: ['CLIENTS', 'BARBERSHOPS'],
    default: 'CLIENTS',
    description: 'CLIENTS: cosmética y cuidado personal; BARBERSHOPS: herramientas e insumos.',
  })
  @IsOptional()
  @IsIn(['CLIENTS', 'BARBERSHOPS'])
  audience?: 'CLIENTS' | 'BARBERSHOPS';

  @ApiPropertyOptional({
    enum: SPONSOR_CATEGORIES,
    description: 'Filtra marcas, ofertas y productos.',
  })
  @IsOptional()
  @IsIn(SPONSOR_CATEGORIES)
  category?: SponsorCategory;
}

export class StoreProductDto extends PublicProductDto {
  @ApiProperty()
  sponsorName!: string;

  @ApiProperty({ type: String, nullable: true })
  sponsorLogoUrl!: string | null;

  @ApiProperty({ enum: SPONSOR_CATEGORIES })
  category!: SponsorCategory;
}

export class StoreBrandDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  coverUrl!: string | null;

  @ApiProperty({ enum: SPONSOR_CATEGORIES })
  category!: SponsorCategory;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ description: 'Productos visibles para este público.' })
  productCount!: number;

  @ApiProperty({ description: 'Tiene al menos una oferta vigente.' })
  hasOffers!: boolean;
}

export class StoreVideoDto extends VideoDto {
  @ApiProperty({ format: 'uuid' })
  sponsorId!: string;

  @ApiProperty()
  sponsorName!: string;

  @ApiProperty({ type: String, nullable: true })
  sponsorLogoUrl!: string | null;
}

export class StoreDealDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['PERCENTAGE', 'FIXED_AMOUNT'] })
  type!: 'PERCENTAGE' | 'FIXED_AMOUNT';

  @ApiProperty({ description: 'Porcentaje (1 a 100) o monto en céntimos.' })
  value!: number;

  @ApiProperty({ type: String, nullable: true })
  currency!: string | null;

  @ApiProperty({ type: [Number], description: 'Días de la cita (0 = domingo); vacío: todos.' })
  daysOfWeek!: number[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endsAt!: Date | null;

  @ApiProperty({ description: 'true: la ofrece Charles y vale en todas las barberías.' })
  fromCharles!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  barbershopId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  barbershopName!: string | null;
}

export class StoreCategoryDto {
  @ApiProperty({ enum: SPONSOR_CATEGORIES })
  category!: SponsorCategory;

  @ApiProperty({ description: 'Marcas con productos para este público.' })
  brands!: number;
}

export class StoreDto {
  @ApiProperty({ type: [PublicPlacementDto], description: 'Destacados (espacio store_featured).' })
  featured!: PublicPlacementDto[];

  @ApiProperty({
    type: [StoreProductDto],
    description: 'Ofertas vigentes, mayor descuento primero.',
  })
  offers!: StoreProductDto[];

  @ApiProperty({
    type: [StoreProductDto],
    description: 'Productos sin oferta, los más nuevos primero.',
  })
  products!: StoreProductDto[];

  @ApiProperty({ type: [StoreBrandDto] })
  brands!: StoreBrandDto[];

  @ApiProperty({ type: [StoreCategoryDto], description: 'Rubros con marcas (para los filtros).' })
  categories!: StoreCategoryDto[];

  @ApiProperty({ type: [StoreVideoDto] })
  videos!: StoreVideoDto[];

  @ApiProperty({
    type: [StoreDealDto],
    description: 'Descuentos en reservas (de Charles y de barberías). Vacío para BARBERSHOPS.',
  })
  deals!: StoreDealDto[];
}

export class ProductClickDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sin sesión: identificador aleatorio de la instalación. Con sesión se ignora.',
  })
  @IsOptional()
  @IsUUID()
  viewerKey?: string;
}
