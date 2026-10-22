import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const MEMBERSHIP_STATUSES = [
  'PENDING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'EXPIRED',
] as const;

export class MembershipPlanServiceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class MembershipPlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty({ example: 'Corte mensual' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ description: 'Céntimos por mes.', example: 9000 })
  priceAmount!: number;

  @ApiProperty({ example: 'PEN' })
  currency!: string;

  @ApiProperty({ description: 'Créditos por mes (1 crédito = 1 servicio).', example: 4 })
  creditsPerPeriod!: number;

  @ApiProperty({
    type: [MembershipPlanServiceDto],
    description: 'Servicios que cubre (vacío: todos).',
  })
  services!: MembershipPlanServiceDto[];

  @ApiProperty()
  isActive!: boolean;
}

export class ManagedMembershipPlanDto extends MembershipPlanDto {
  @ApiProperty({ description: 'Membresías vigentes de clientes.' })
  activeMembers!: number;
}

export class CreateMembershipPlanDto {
  @ApiProperty({ example: 'Corte mensual' })
  @Transform(trim)
  @IsString()
  @Length(3, 80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ description: 'Céntimos por mes (mínimo S/ 10).' })
  @IsInt()
  @Min(1000)
  @Max(1_000_000)
  priceAmount!: number;

  @ApiProperty({ minimum: 1, maximum: 60 })
  @IsInt()
  @Min(1)
  @Max(60)
  creditsPerPeriod!: number;

  @ApiPropertyOptional({ type: [String], description: 'Servicios que cubre (vacío: todos).' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  serviceIds?: string[];
}

export class UpdateMembershipPlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 80)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Solo para membresías nuevas; las vigentes conservan su precio.',
  })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(1_000_000)
  priceAmount?: number;

  @ApiPropertyOptional({ description: 'Solo para membresías nuevas.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  creditsPerPeriod?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  serviceIds?: string[];

  @ApiPropertyOptional({ description: 'false: deja de venderse (las vigentes siguen).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class MembershipDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: MembershipPlanDto })
  plan!: MembershipPlanDto;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty({ enum: MEMBERSHIP_STATUSES })
  status!: (typeof MEMBERSHIP_STATUSES)[number];

  @ApiProperty({ description: 'Precio que paga (fijo desde que se suscribió).' })
  priceAmount!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ description: 'Créditos disponibles ahora.' })
  credits!: number;

  @ApiProperty({ type: Date, nullable: true, description: 'Vence el próximo lote de créditos.' })
  nextCreditsExpireAt!: Date | null;

  @ApiProperty({ type: String, nullable: true, description: 'Enlace de pago (solo PENDING).' })
  checkoutUrl!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  currentPeriodEnd!: Date | null;

  @ApiProperty()
  cancelAtPeriodEnd!: boolean;

  @ApiProperty()
  createdAt!: Date;
}

export class ShopMemberDto {
  @ApiProperty({ format: 'uuid' })
  membershipId!: string;

  @ApiProperty({ description: 'Usuario de la app del cliente.' })
  username!: string;

  @ApiProperty()
  planName!: string;

  @ApiProperty({ enum: MEMBERSHIP_STATUSES })
  status!: (typeof MEMBERSHIP_STATUSES)[number];

  @ApiProperty()
  credits!: number;

  @ApiProperty({ type: Date, nullable: true })
  currentPeriodEnd!: Date | null;
}

export class PayWithMembershipDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  membershipId!: string;
}
