import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
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
} from 'class-validator';
import { MoneyDto } from '../../barbershops/dto/barbershop.dto';
import { CLIENT_TIERS } from '../discount-policy';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Código de cupón: 4 a 20 letras o números, sin espacios. Se guarda en mayúsculas. */
export const COUPON_CODE_PATTERN = /^[A-Z0-9]{4,20}$/;
/** Monto fijo: de S/ 1 a S/ 500. */
export const FIXED_AMOUNT_LIMITS = { min: 100, max: 50_000 } as const;

export const PROMOTION_TYPES = ['PERCENTAGE', 'FIXED_AMOUNT'] as const;
export const PROMOTION_SCOPES = ['PLATFORM', 'BARBERSHOP', 'SERVICE'] as const;

/** Campos comunes al crear (barbería o ADMIN). */
export class CreatePromotionDto {
  @ApiProperty({ minLength: 3, maxLength: 80, example: '20 % los martes' })
  @Transform(trim)
  @IsString()
  @Length(3, 80)
  name!: string;

  @ApiProperty({ enum: PROMOTION_TYPES, enumName: 'PromotionType' })
  @IsIn(PROMOTION_TYPES)
  type!: (typeof PROMOTION_TYPES)[number];

  @ApiProperty({
    description:
      'PERCENTAGE: 1 a 100 (porcentaje). FIXED_AMOUNT: céntimos en PEN, de 100 (S/ 1) a 50000 (S/ 500).',
    example: 20,
  })
  @IsInt()
  @Min(1)
  @ValidateIf((o: CreatePromotionDto) => o.type === 'PERCENTAGE')
  @Max(100)
  value!: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo barberías: limita la promoción a un servicio propio (alcance SERVICE).',
  })
  @IsOptional()
  @IsUUID()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Por defecto, ahora.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @ApiPropertyOptional({ type: Date, nullable: true, description: 'null o ausente: sin fin.' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 100000, description: 'Usos totales.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  maxRedemptions?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, description: 'Usos por cliente.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxPerUser?: number;

  @ApiPropertyOptional({
    type: [Number],
    description: 'Días de la cita en que aplica (0 = domingo … 6 = sábado). Vacío: todos.',
    example: [2],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  @ApiPropertyOptional({
    enum: CLIENT_TIERS,
    description:
      'Solo barberías con ranking de clientes en su plan: la promoción aplica a clientes de ese ' +
      'nivel o superior (BRONZE < SILVER < GOLD).',
  })
  @IsOptional()
  @IsIn(CLIENT_TIERS)
  minTier?: (typeof CLIENT_TIERS)[number];

  @ApiPropertyOptional({
    default: false,
    description: 'true: solo con cupón (se crean aparte). false: se aplica sola.',
  })
  @IsOptional()
  @IsBoolean()
  requiresCoupon?: boolean;
}

/** Lo editable después de crear. Tipo, valor y alcance no cambian: se crea otra promoción. */
export class UpdatePromotionDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 80)
  name?: string;

  @ApiPropertyOptional({ type: Date, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Type(() => Date)
  @IsDate()
  endsAt?: Date | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 100000 })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(1)
  @Max(100_000)
  maxRedemptions?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 100 })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(1)
  @Max(100)
  maxPerUser?: number | null;

  @ApiPropertyOptional({ description: 'false la pausa; true la reanuda.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateCouponDto {
  @ApiProperty({
    example: 'BIENVENIDO10',
    description: '4 a 20 letras o números; se guarda en mayúsculas.',
  })
  @Transform(upper)
  @IsString()
  @Matches(COUPON_CODE_PATTERN)
  code!: string;
}

export class CouponDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ description: 'Canjes vigentes (sin contar reservas canceladas o vencidas).' })
  redemptions!: number;

  @ApiProperty()
  createdAt!: Date;
}

export class PromotionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: PROMOTION_SCOPES, enumName: 'PromotionScope' })
  scope!: (typeof PROMOTION_SCOPES)[number];

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  barbershopId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  serviceId!: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: PROMOTION_TYPES, enumName: 'PromotionType' })
  type!: (typeof PROMOTION_TYPES)[number];

  @ApiProperty()
  value!: number;

  @ApiProperty({ type: String, nullable: true })
  currency!: string | null;

  @ApiProperty()
  startsAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  endsAt!: Date | null;

  @ApiProperty({ type: Number, nullable: true })
  maxRedemptions!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  maxPerUser!: number | null;

  @ApiProperty({ type: [Number] })
  daysOfWeek!: number[];

  @ApiProperty({ enum: CLIENT_TIERS, nullable: true, description: 'Nivel mínimo del ranking.' })
  minTier!: (typeof CLIENT_TIERS)[number] | null;

  @ApiProperty()
  requiresCoupon!: boolean;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({
    enum: ['SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED', 'EXHAUSTED'],
    description: 'Calculado: programada, vigente, pausada, terminada o sin cupos.',
  })
  status!: 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'EXHAUSTED';

  @ApiProperty({ description: 'Canjes vigentes.' })
  redemptions!: number;

  @ApiProperty({ type: MoneyDto, description: 'Total descontado en canjes vigentes.' })
  discountedTotal!: MoneyDto;

  @ApiProperty({ type: [CouponDto] })
  coupons!: CouponDto[];

  @ApiProperty()
  createdAt!: Date;
}

/** Promoción automática vigente, para mostrar en la barbería (sin cupos ni cupones). */
export class PublicPromotionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: PROMOTION_TYPES, enumName: 'PromotionType' })
  type!: (typeof PROMOTION_TYPES)[number];

  @ApiProperty()
  value!: number;

  @ApiProperty({ type: String, nullable: true })
  currency!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'null: todos los servicios.',
  })
  serviceId!: string | null;

  @ApiProperty({ type: [Number] })
  daysOfWeek!: number[];

  @ApiProperty({ type: Date, nullable: true })
  endsAt!: Date | null;

  @ApiProperty({ description: 'true: la ofrece Charles (vale en toda la app).' })
  fromCharles!: boolean;
}

export class AdminPromotionsQueryDto {
  @ApiPropertyOptional({ enum: PROMOTION_SCOPES })
  @IsOptional()
  @IsEnum({ PLATFORM: 'PLATFORM', BARBERSHOP: 'BARBERSHOP', SERVICE: 'SERVICE' })
  scope?: (typeof PROMOTION_SCOPES)[number];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  barbershopId?: string;
}

// ───────────── Cotización ─────────────

export class QuoteBookingDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  barbershopId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceId!: string;

  @ApiProperty({ description: 'Inicio del turno (define el día para las promociones por día).' })
  @Type(() => Date)
  @IsDate()
  startAt!: Date;

  @ApiPropertyOptional({ example: 'BIENVENIDO10' })
  @IsOptional()
  @Transform(upper)
  @IsString()
  @Length(1, 40)
  couponCode?: string;
}

export const COUPON_REJECTIONS = [
  'NOT_FOUND',
  'NOT_ACTIVE',
  'NOT_APPLICABLE',
  'EXHAUSTED',
  'ALREADY_USED',
] as const;
export type CouponRejection = (typeof COUPON_REJECTIONS)[number];

export class QuoteCouponDto {
  @ApiProperty()
  code!: string;

  @ApiProperty({ description: 'true si el descuento elegido es el del cupón.' })
  applied!: boolean;

  @ApiProperty({
    enum: [...COUPON_REJECTIONS, 'BETTER_PROMOTION'],
    nullable: true,
    description:
      'Por qué no se aplicó: no existe, no vigente, no aplica a esta reserva, sin cupos, ya lo ' +
      'usaste, o hay una promoción mejor (un solo descuento por reserva).',
  })
  reason!: CouponRejection | 'BETTER_PROMOTION' | null;
}

export class QuoteLineDto {
  @ApiProperty({ enum: ['SERVICE', 'DISCOUNT', 'FEE'] })
  type!: 'SERVICE' | 'DISCOUNT' | 'FEE';

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: MoneyDto, description: 'Siempre positivo; DISCOUNT se resta.' })
  amount!: MoneyDto;
}

export class QuotePromotionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class BookingQuoteDto {
  @ApiProperty({ type: MoneyDto })
  subtotal!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  discountTotal!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  feeTotal!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  total!: MoneyDto;

  @ApiProperty({ type: [QuoteLineDto] })
  lines!: QuoteLineDto[];

  @ApiProperty({ type: QuotePromotionDto, nullable: true })
  promotion!: QuotePromotionDto | null;

  @ApiProperty({
    type: QuoteCouponDto,
    nullable: true,
    description: 'Solo si se envió couponCode.',
  })
  coupon!: QuoteCouponDto | null;
}
