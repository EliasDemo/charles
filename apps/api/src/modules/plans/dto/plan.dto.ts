import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ArrayMaxSize,
  IsArray,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const PLAN_AUDIENCES = ['BARBERSHOP', 'BARBER'] as const;
export const BILLING_INTERVALS = ['MONTHLY', 'YEARLY'] as const;
export const SUBSCRIPTION_STATUSES = [
  'PENDING',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'EXPIRED',
] as const;

export class EntitlementDefinitionDto {
  @ApiProperty({ example: 'barbers' })
  key!: string;

  @ApiProperty({ enum: ['LIMIT', 'TOGGLE'] })
  kind!: 'LIMIT' | 'TOGGLE';

  @ApiProperty({ example: 'Barberos activos' })
  label!: string;
}

export class PlanEntitlementDto {
  @ApiProperty({ example: 'barbers' })
  key!: string;

  @ApiProperty({ enum: ['LIMIT', 'TOGGLE'] })
  kind!: 'LIMIT' | 'TOGGLE';

  @ApiProperty()
  label!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'LIMIT: máximo (null = ilimitado; 0 = no incluido). TOGGLE: 1 incluido, 0 no.',
  })
  value!: number | null;
}

export class PlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'pro' })
  code!: string;

  @ApiProperty({ example: 'Pro' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({
    enum: PLAN_AUDIENCES,
    description: 'BARBERSHOP: barberías. BARBER: barberos independientes.',
  })
  audience!: (typeof PLAN_AUDIENCES)[number];

  @ApiProperty({ description: 'Céntimos por mes.', example: 5900 })
  priceMonthly!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Céntimos por año (null: sin opción anual).',
  })
  priceYearly!: number | null;

  @ApiProperty({ example: 'PEN' })
  currency!: string;

  @ApiProperty({ example: 14 })
  trialDays!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Comisión por reserva en puntos básicos (500 = 5 %). null: la general.',
  })
  commissionBp!: number | null;

  @ApiProperty()
  isDefault!: boolean;

  @ApiProperty({ type: [PlanEntitlementDto] })
  entitlements!: PlanEntitlementDto[];
}

export class AdminPlanDto extends PlanDto {
  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isVisible!: boolean;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ description: 'Suscripciones vivas (en prueba, activas o con pago atrasado).' })
  liveSubscriptions!: number;
}

export class PlansQueryDto {
  @ApiPropertyOptional({ enum: PLAN_AUDIENCES })
  @IsOptional()
  @IsIn(PLAN_AUDIENCES)
  audience?: (typeof PLAN_AUDIENCES)[number];
}

export class CreatePlanDto {
  @ApiProperty({ example: 'pro', description: 'Minúsculas, números y _ (2 a 40).' })
  @Transform(trim)
  @Matches(/^[a-z0-9_]{2,40}$/)
  code!: string;

  @ApiProperty({ example: 'Pro' })
  @Transform(trim)
  @IsString()
  @Length(2, 40)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 300)
  description?: string;

  @ApiProperty({ enum: PLAN_AUDIENCES })
  @IsIn(PLAN_AUDIENCES)
  audience!: (typeof PLAN_AUDIENCES)[number];

  @ApiProperty({ description: 'Céntimos por mes (0 para el plan gratis).' })
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceMonthly!: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  priceYearly?: number | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  trialDays?: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3000)
  commissionBp?: number | null;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @ApiPropertyOptional({ default: false, description: 'Plan por defecto (gratis) de su público.' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
}

export class UpdatePlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 40)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 300)
  description?: string | null;

  @ApiPropertyOptional({
    description:
      'Nuevo precio mensual. Las suscripciones vigentes lo pagan desde su renovación, con aviso previo.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  priceMonthly?: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  priceYearly?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  trialDays?: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3000)
  commissionBp?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'false: se deja de ofrecer (sus suscriptores siguen).' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @ApiPropertyOptional({ description: 'false: no admite suscripciones nuevas.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({ minLength: 5, maxLength: 500, description: 'Motivo (auditoría).' })
  @Transform(trim)
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class SetEntitlementsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number', nullable: true },
    example: {
      barbers: 6,
      gallery_photos: 150,
      promotions: 1,
      memberships: 0,
      messages_month: null,
    },
    description:
      'Clave → valor. LIMIT: número o null (ilimitado). TOGGLE: 1 o 0. Las claves omitidas se quitan (no incluidas).',
  })
  @IsObject()
  values!: Record<string, number | null>;

  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class PlanUsageDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ enum: ['LIMIT', 'TOGGLE'] })
  kind!: 'LIMIT' | 'TOGGLE';

  @ApiProperty({ type: Number, nullable: true, description: 'Límite (null ilimitado) o 1/0.' })
  limit!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Usado (solo límites con medición).' })
  used!: number | null;
}

export class SubscriptionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: SUBSCRIPTION_STATUSES })
  status!: (typeof SUBSCRIPTION_STATUSES)[number];

  @ApiProperty({ enum: BILLING_INTERVALS })
  interval!: (typeof BILLING_INTERVALS)[number];

  @ApiProperty({ type: PlanDto })
  plan!: PlanDto;

  @ApiProperty()
  priceAmount!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ type: Number, nullable: true, description: 'Precio desde la próxima renovación.' })
  nextPriceAmount!: number | null;

  @ApiProperty({ type: Date, nullable: true })
  nextPriceFrom!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Enlace de pago (solo mientras está PENDING). La app no lo abre: se envía por correo.',
  })
  checkoutUrl!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  trialEndsAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  currentPeriodEnd!: Date | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'Con pago atrasado: fin del periodo de gracia.',
  })
  graceUntil!: Date | null;

  @ApiProperty()
  cancelAtPeriodEnd!: boolean;

  @ApiProperty()
  createdAt!: Date;
}

export class BarbershopPlanDto {
  @ApiProperty({
    type: PlanDto,
    nullable: true,
    description: 'null: sin planes configurados (sin límites).',
  })
  plan!: PlanDto | null;

  @ApiProperty({
    type: SubscriptionDto,
    nullable: true,
    description: 'Suscripción vigente o pendiente de pago.',
  })
  subscription!: SubscriptionDto | null;

  @ApiProperty({ type: [PlanUsageDto] })
  usage!: PlanUsageDto[];

  @ApiProperty({
    description: 'Barberos que el plan dejó inactivos (se reactivan al subir de plan).',
  })
  suspendedBarbers!: number;

  @ApiProperty({ description: 'Fotos que el plan ocultó.' })
  hiddenPhotos!: number;
}

export class PublicPlanBadgesDto {
  @ApiProperty({ description: 'Insignia "Verificada" del plan.' })
  verified!: boolean;
}

export class SubscribeDto {
  @ApiProperty({ example: 'pro' })
  @Matches(/^[a-z0-9_]{2,40}$/)
  planCode!: string;

  @ApiPropertyOptional({ enum: BILLING_INTERVALS, default: 'MONTHLY' })
  @IsOptional()
  @IsIn(BILLING_INTERVALS)
  interval?: (typeof BILLING_INTERVALS)[number];

  @ApiPropertyOptional({
    default: false,
    description:
      'true: reemplaza la suscripción vigente (cambio de plan). Si no, 409 SUBSCRIPTION_EXISTS.',
  })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;

  @ApiPropertyOptional({
    enum: ['GATEWAY', 'BALANCE'],
    default: 'GATEWAY',
    description:
      'GATEWAY: enlace de pago por correo (Mercado Pago). BALANCE: se paga al instante con el saldo a ' +
      'favor de la barbería (sin prueba gratis) y se renueva sola con el saldo; si no alcanza, queda ' +
      'PAST_DUE. 409 INSUFFICIENT_BALANCE si no alcanza.',
  })
  @IsOptional()
  @IsIn(['GATEWAY', 'BALANCE'])
  paymentMethod?: 'GATEWAY' | 'BALANCE';
}

export class CancelSubscriptionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 500)
  reason?: string;
}

export class ActiveBarbersDto {
  @ApiProperty({
    type: [String],
    description: 'Barberos que siguen activos (hasta el límite del plan).',
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  barberIds!: string[];
}

export class AdminSubscriptionsQueryDto {
  @ApiPropertyOptional({ enum: SUBSCRIPTION_STATUSES })
  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: (typeof SUBSCRIPTION_STATUSES)[number];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  barbershopId?: string;
}

export class AdminSubscriptionDto extends SubscriptionDto {
  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty({ type: Date, nullable: true })
  canceledAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  cancelReason!: string | null;
}

export class AdminReasonDto {
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class ExtendSubscriptionDto extends AdminReasonDto {
  @ApiProperty({
    minimum: 1,
    maximum: 90,
    description: 'Días de cortesía que se suman al periodo actual.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days!: number;
}

export class UseFeaturedDaysDto {
  @ApiPropertyOptional({ description: 'Inicio (por defecto, ahora).' })
  @IsOptional()
  @Type(() => Date)
  startsAt?: Date;

  @ApiProperty({ minimum: 1, maximum: 31 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  days!: number;
}

export class FeaturedFromPlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  startsAt!: Date;

  @ApiProperty()
  endsAt!: Date;

  @ApiProperty({ description: 'Días del plan usados este mes (incluido este).' })
  daysUsed!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Días por mes del plan (null: ilimitado).',
  })
  daysLimit!: number | null;
}

export class PlanCountDto {
  @ApiProperty()
  planCode!: string;

  @ApiProperty()
  planName!: string;

  @ApiProperty({ enum: SUBSCRIPTION_STATUSES })
  status!: (typeof SUBSCRIPTION_STATUSES)[number];

  @ApiProperty()
  count!: number;
}

export class PurposeAmountDto {
  @ApiProperty({ enum: ['SUBSCRIPTION', 'SPONSOR_PACKAGE', 'MEMBERSHIP'] })
  purpose!: 'SUBSCRIPTION' | 'SPONSOR_PACKAGE' | 'MEMBERSHIP';

  @ApiProperty({ description: 'Céntimos cobrados en el mes.' })
  amount!: number;

  @ApiProperty()
  count!: number;
}

export class BillingSummaryDto {
  @ApiProperty({
    description: 'Ingreso mensual recurrente de los planes (céntimos; anuales ÷ 12).',
  })
  mrr!: number;

  @ApiProperty({ description: 'Suscripciones con pago atrasado.' })
  pastDue!: number;

  @ApiProperty({ description: 'Suscripciones en prueba gratis.' })
  trialing!: number;

  @ApiProperty({ type: [PlanCountDto] })
  byPlan!: PlanCountDto[];

  @ApiProperty({ type: [PurposeAmountDto], description: 'Cobros confirmados del mes calendario.' })
  chargesThisMonth!: PurposeAmountDto[];

  @ApiProperty({ description: 'Comisiones por reservas del mes (céntimos).' })
  commissionsThisMonth!: number;
}
