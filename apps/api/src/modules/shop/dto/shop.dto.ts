import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
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
  ValidateNested,
} from 'class-validator';
import { USERNAME_PATTERN } from '../../users/username';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const emptyToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === ''
    ? null
    : typeof value === 'string'
      ? value.trim()
      : value;
const toBool = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export const CLIENT_TIERS_ALL = ['NONE', 'BRONZE', 'SILVER', 'GOLD'] as const;
export const SALE_METHODS = ['CASH', 'YAPE', 'CARD', 'TRANSFER', 'MEMBERSHIP_CREDIT'] as const;
export const SALE_STATUSES = ['COMPLETED', 'VOIDED'] as const;
export const INVOICE_STATUSES = ['PENDING', 'ISSUED', 'REJECTED', 'FAILED', 'VOIDED'] as const;
export const INVOICE_PROVIDERS = ['FAKE', 'NUBEFACT'] as const;
export const DOC_TYPES = ['DNI', 'CE', 'RUC', 'NONE'] as const;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;

// ───────────── Clientes ─────────────

export class ShopClientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Ana' })
  displayName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Usuario en la app (si tiene cuenta).',
  })
  username!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Preferencias (corte, máquina, etc.).',
  })
  preferences!: string | null;

  @ApiProperty()
  isRegular!: boolean;

  @ApiProperty({ enum: CLIENT_TIERS_ALL })
  tier!: (typeof CLIENT_TIERS_ALL)[number];

  @ApiProperty()
  score!: number;

  @ApiProperty()
  visitsCount!: number;

  @ApiProperty({ description: 'Céntimos gastados (en la ventana del ranking).' })
  totalSpent!: number;

  @ApiProperty({ type: Date, nullable: true })
  firstVisitAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  lastVisitAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class ClientVisitDto {
  @ApiProperty({ enum: ['BOOKING', 'SALE'] })
  source!: 'BOOKING' | 'SALE';

  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  at!: Date;

  @ApiProperty({ type: [String], description: 'Servicios.' })
  services!: string[];

  @ApiProperty({ type: String, nullable: true })
  barberName!: string | null;

  @ApiProperty()
  totalAmount!: number;
}

export class ShopClientDetailDto extends ShopClientDto {
  @ApiProperty({
    type: [ClientVisitDto],
    description: 'Últimas 30 visitas (reservas atendidas y ventas).',
  })
  visits!: ClientVisitDto[];
}

export class ShopClientsQueryDto {
  @ApiPropertyOptional({ description: 'Busca por nombre o usuario.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  q?: string;

  @ApiPropertyOptional({ enum: CLIENT_TIERS_ALL })
  @IsOptional()
  @IsIn(CLIENT_TIERS_ALL)
  tier?: (typeof CLIENT_TIERS_ALL)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  regular?: boolean;

  @ApiPropertyOptional({ enum: ['recent', 'score', 'name'], default: 'recent' })
  @IsOptional()
  @IsIn(['recent', 'score', 'name'])
  sort?: 'recent' | 'score' | 'name';
}

export class CreateShopClientDto {
  @ApiPropertyOptional({
    description: 'Nombre (obligatorio si no se indica el usuario de la app).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  displayName?: string;

  @ApiPropertyOptional({
    description: 'Usuario de la app, para vincularlo (su historial de reservas se suma).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(USERNAME_PATTERN)
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @Matches(PHONE)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  preferences?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isRegular?: boolean;
}

export class UpdateShopClientDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  displayName?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @Matches(PHONE)
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(300)
  preferences?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRegular?: boolean;

  @ApiPropertyOptional({ description: 'true: lo archiva (deja de contar en el límite del plan).' })
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class RankingTierCountDto {
  @ApiProperty({ enum: CLIENT_TIERS_ALL })
  tier!: (typeof CLIENT_TIERS_ALL)[number];

  @ApiProperty()
  count!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Puntaje mínimo del nivel.' })
  minScore!: number | null;
}

export class RankingDto {
  @ApiProperty({ type: [RankingTierCountDto] })
  tiers!: RankingTierCountDto[];

  @ApiProperty({ type: [ShopClientDto], description: 'Los 50 mejores clientes.' })
  top!: ShopClientDto[];

  @ApiProperty({ description: 'Días que considera el puntaje.' })
  windowDays!: number;

  @ApiProperty({ type: Date, nullable: true })
  rankedAt!: Date | null;
}

// ───────────── Catálogo de cortes ─────────────

export class CatalogItemDto {
  @ApiProperty({ format: 'uuid', description: 'ID del servicio.' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  priceAmount!: number;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty()
  isAvailable!: boolean;

  @ApiProperty({ type: String, nullable: true })
  styleKey!: string | null;

  @ApiProperty({ type: String, nullable: true })
  styleName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  coverUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Barbero de la foto de portada.' })
  fromBarberName!: string | null;
}

export class CatalogSourceDto {
  @ApiProperty({ format: 'uuid', description: 'ID de la foto del portafolio.' })
  imageId!: string;

  @ApiProperty()
  imageUrl!: string;

  @ApiProperty()
  barberName!: string;

  @ApiProperty({ type: String, nullable: true })
  caption!: string | null;

  @ApiProperty({ type: [String], description: 'Claves de los estilos de la foto.' })
  styleKeys!: string[];
}

export class UpdateCatalogItemDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Clave del estilo (null lo quita).',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(60)
  styleKey?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Foto de portada.',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsUUID()
  coverImageId?: string | null;
}

export class ImportCatalogItemDto {
  @ApiProperty({ format: 'uuid', description: 'Foto del portafolio de un barbero de la barbería.' })
  @IsUUID()
  imageId!: string;

  @ApiPropertyOptional({ description: 'Por defecto, el nombre del estilo de la foto.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiProperty({ description: 'Céntimos.' })
  @IsInt()
  @Min(100)
  @Max(1_000_000)
  priceAmount!: number;

  @ApiProperty({ minimum: 5, maximum: 480 })
  @IsInt()
  @Min(5)
  @Max(480)
  durationMinutes!: number;
}

// ───────────── Caja y ventas ─────────────

export class CashSessionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  openedAt!: Date;

  @ApiProperty()
  openingAmount!: number;

  @ApiProperty({ type: Date, nullable: true })
  closedAt!: Date | null;

  @ApiProperty({ description: 'Efectivo esperado: apertura + ventas en efectivo del turno.' })
  expectedAmount!: number;

  @ApiProperty({ type: Number, nullable: true })
  countedAmount!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Contado − esperado.' })
  difference!: number | null;

  @ApiProperty({ description: 'Ventas del turno (no anuladas).' })
  salesCount!: number;

  @ApiProperty({ description: 'Total vendido en el turno (todos los medios).' })
  salesTotal!: number;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;
}

export class OpenCashDto {
  @ApiProperty({ description: 'Efectivo inicial (céntimos).' })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  openingAmount!: number;
}

export class CloseCashDto {
  @ApiProperty({ description: 'Efectivo contado al cerrar (céntimos).' })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  countedAmount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class SaleLineInputDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Servicio de la barbería (o descripción libre).',
  })
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Obligatoria si no hay servicio.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  description?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  quantity?: number;

  @ApiPropertyOptional({ description: 'Céntimos. Por defecto, el precio del servicio.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  unitAmount?: number;
}

export class CustomerDocDto {
  @ApiProperty({ enum: DOC_TYPES })
  @IsIn(DOC_TYPES)
  type!: (typeof DOC_TYPES)[number];

  @ApiPropertyOptional({ description: 'DNI 8 dígitos, CE hasta 12, RUC 11.' })
  @IsOptional()
  @Matches(/^[0-9A-Za-z]{8,12}$/)
  number?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  name?: string;
}

export class CreateSaleDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Cliente del panel (o venta anónima).' })
  @IsOptional()
  @IsUUID()
  shopClientId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  barberId?: string;

  @ApiProperty({ type: [SaleLineInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SaleLineInputDto)
  lines!: SaleLineInputDto[];

  @ApiPropertyOptional({
    description: 'Descuento en céntimos (no supera el subtotal).',
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  discountAmount?: number;

  @ApiProperty({ enum: SALE_METHODS })
  @IsIn(SALE_METHODS)
  paymentMethod!: (typeof SALE_METHODS)[number];

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Con MEMBERSHIP_CREDIT: membresía del cliente (usa 1 crédito).',
  })
  @IsOptional()
  @IsUUID()
  membershipId?: string;

  @ApiPropertyOptional({ default: false, description: 'Emitir boleta electrónica.' })
  @IsOptional()
  @IsBoolean()
  issueInvoice?: boolean;

  @ApiPropertyOptional({ type: CustomerDocDto, description: 'Datos del comprador para la boleta.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerDocDto)
  customer?: CustomerDocDto;
}

export class VoidSaleDto {
  @ApiProperty({ minLength: 5, maxLength: 300 })
  @Transform(trim)
  @IsString()
  @Length(5, 300)
  reason!: string;
}

export class SaleLineDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  serviceId!: string | null;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  quantity!: number;

  @ApiProperty()
  unitAmount!: number;

  @ApiProperty()
  totalAmount!: number;
}

export class InvoiceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'B001-00000012' })
  number!: string;

  @ApiProperty({ enum: INVOICE_STATUSES })
  status!: (typeof INVOICE_STATUSES)[number];

  @ApiProperty()
  totalAmount!: number;

  @ApiProperty({ description: 'IGV incluido en el total.' })
  taxAmount!: number;

  @ApiProperty({ type: String, nullable: true })
  pdfUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  issuedAt!: Date | null;
}

export class SaleDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  shopClientId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  clientName!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  barberId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  barberName!: string | null;

  @ApiProperty({ type: [SaleLineDto] })
  lines!: SaleLineDto[];

  @ApiProperty()
  subtotalAmount!: number;

  @ApiProperty()
  discountAmount!: number;

  @ApiProperty()
  totalAmount!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ enum: SALE_METHODS })
  paymentMethod!: (typeof SALE_METHODS)[number];

  @ApiProperty({ enum: SALE_STATUSES })
  status!: (typeof SALE_STATUSES)[number];

  @ApiProperty({ type: String, nullable: true })
  voidReason!: string | null;

  @ApiProperty({ type: InvoiceDto, nullable: true })
  invoice!: InvoiceDto | null;

  @ApiProperty()
  soldAt!: Date;
}

export class SalesQueryDto {
  @ApiPropertyOptional({ description: 'Desde (incluido). Por defecto, hoy en Lima.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ description: 'Hasta (excluido).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  barberId?: string;
}

export class InvoicingConfigDto {
  @ApiProperty({ enum: INVOICE_PROVIDERS })
  provider!: (typeof INVOICE_PROVIDERS)[number];

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ example: 'B001' })
  series!: string;

  @ApiProperty()
  nextNumber!: number;

  @ApiProperty({ description: 'Hay ruta y token guardados (nunca se devuelven).' })
  hasCredentials!: boolean;
}

export class UpdateInvoicingConfigDto {
  @ApiProperty({ enum: INVOICE_PROVIDERS })
  @IsIn(INVOICE_PROVIDERS)
  provider!: (typeof INVOICE_PROVIDERS)[number];

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ example: 'B001', description: 'Serie de boletas (B + 3 letras o números).' })
  @Matches(/^B[0-9A-Z]{3}$/)
  series!: string;

  @ApiPropertyOptional({ description: 'NUBEFACT: RUTA de la cuenta (https).' })
  @IsOptional()
  @Matches(/^https:\/\/[^\s]+$/)
  @MaxLength(300)
  apiUrl?: string;

  @ApiPropertyOptional({ description: 'NUBEFACT: TOKEN de la cuenta.' })
  @IsOptional()
  @IsString()
  @Length(10, 200)
  token?: string;
}

// ───────────── Reportes ─────────────

export class ReportsQueryDto {
  @ApiProperty({ description: 'Desde (incluido).' })
  @Type(() => Date)
  @IsDate()
  from!: Date;

  @ApiProperty({ description: 'Hasta (excluido). Máximo 366 días.' })
  @Type(() => Date)
  @IsDate()
  to!: Date;
}

export class ReportDayDto {
  @ApiProperty({ example: '2026-10-20' })
  day!: string;

  @ApiProperty()
  appAmount!: number;

  @ApiProperty()
  localAmount!: number;

  @ApiProperty()
  count!: number;
}

export class ReportBarberDto {
  @ApiProperty({ format: 'uuid' })
  barberId!: string;

  @ApiProperty()
  barberName!: string;

  @ApiProperty()
  count!: number;

  @ApiProperty()
  amount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Porcentaje de comisión (puntos básicos).',
  })
  commissionBp!: number | null;

  @ApiProperty({ description: 'Comisión del barbero (céntimos).' })
  commissionAmount!: number;
}

export class ReportServiceDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  count!: number;

  @ApiProperty()
  amount!: number;
}

export class ReportMethodDto {
  @ApiProperty({ enum: SALE_METHODS })
  method!: (typeof SALE_METHODS)[number];

  @ApiProperty()
  amount!: number;

  @ApiProperty()
  count!: number;
}

export class SalesReportDto {
  @ApiProperty()
  from!: Date;

  @ApiProperty()
  to!: Date;

  @ApiProperty({ description: 'Reservas atendidas pagadas en la app (céntimos).' })
  appAmount!: number;

  @ApiProperty({ description: 'Ventas en el local (céntimos).' })
  localAmount!: number;

  @ApiProperty()
  totalAmount!: number;

  @ApiProperty({ description: 'Atenciones (reservas atendidas + ventas).' })
  count!: number;

  @ApiProperty({ description: 'Ticket promedio (céntimos).' })
  averageTicket!: number;

  @ApiProperty({ description: 'Clientes que vinieron por primera vez en el periodo.' })
  newClients!: number;

  @ApiProperty({ description: 'Clientes que ya habían venido antes.' })
  returningClients!: number;

  @ApiProperty({ type: [ReportDayDto] })
  byDay!: ReportDayDto[];

  @ApiProperty({
    type: [ReportBarberDto],
    description: 'Vacío si el plan no incluye reportes completos.',
  })
  byBarber!: ReportBarberDto[];

  @ApiProperty({
    type: [ReportServiceDto],
    description: 'Vacío si el plan no incluye reportes completos.',
  })
  byService!: ReportServiceDto[];

  @ApiProperty({ type: [ReportMethodDto], description: 'Ventas en el local por medio de pago.' })
  byMethod!: ReportMethodDto[];

  @ApiProperty({ description: 'El plan incluye reportes completos.' })
  full!: boolean;
}

export class BarberCommissionDto {
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  commissionBp!: number | null;
}
