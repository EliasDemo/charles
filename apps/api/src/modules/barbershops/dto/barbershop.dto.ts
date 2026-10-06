import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  registerDecorator,
} from 'class-validator';
import {
  BarbershopMemberRole,
  BarbershopStatus,
  BarbershopType,
} from '../../../generated/prisma/enums';
import { PHONE_PATTERN } from '../../users/dto/profile.dto';

/** Ámbito del MVP: solo Perú (CLAUDE.md §4.1). Rectángulo amplio que contiene al país. */
export const PERU_BOUNDS = { minLat: -18.5, maxLat: 0.1, minLng: -81.5, maxLng: -68.5 } as const;
export const DEFAULT_TIMEZONE = 'America/Lima';
export const RUC_PATTERN = /^\d{11}$/;

const VALID_TIMEZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
/** Cadena vacía → null (para borrar un campo opcional). */
const emptyToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? null : trim({ value });

function IsIanaTimezone(): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isIanaTimezone',
      target: target.constructor,
      propertyName: propertyName.toString(),
      validator: { validate: (v: unknown) => typeof v === 'string' && VALID_TIMEZONES.has(v) },
    });
}

const HTTPS_URL = { protocols: ['https'], require_protocol: true };

/** RF-BAR-001. Obligatorios: nombre, dirección, ubicación y teléfono. */
export class CreateBarbershopDto {
  @ApiProperty({ example: 'Barbería Central' })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty({ example: 'Av. Larco 123, Miraflores, Lima' })
  @Transform(trim)
  @IsString()
  @Length(5, 200)
  address!: string;

  @ApiProperty({ example: -12.1211, description: 'Dentro de Perú (MVP).' })
  @Type(() => Number)
  @IsLatitude()
  @Min(PERU_BOUNDS.minLat)
  @Max(PERU_BOUNDS.maxLat)
  latitude!: number;

  @ApiProperty({ example: -77.0297, description: 'Dentro de Perú (MVP).' })
  @Type(() => Number)
  @IsLongitude()
  @Min(PERU_BOUNDS.minLng)
  @Max(PERU_BOUNDS.maxLng)
  longitude!: number;

  @ApiPropertyOptional({ example: DEFAULT_TIMEZONE, description: 'Zona horaria IANA.' })
  @IsOptional()
  @IsString()
  @IsIanaTimezone()
  timezone?: string;

  @ApiProperty({ example: '+51 1 234 5678' })
  @Transform(trim)
  @IsString()
  @Matches(PHONE_PATTERN)
  phone!: string;

  @ApiPropertyOptional({ example: '20123456789', nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @Matches(RUC_PATTERN)
  ruc?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsUrl(HTTPS_URL)
  @MaxLength(300)
  websiteUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsUrl({ ...HTTPS_URL, host_whitelist: ['instagram.com', 'www.instagram.com'] })
  @MaxLength(300)
  instagramUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsUrl({ ...HTTPS_URL, host_whitelist: ['facebook.com', 'www.facebook.com', 'm.facebook.com'] })
  @MaxLength(300)
  facebookUrl?: string | null;
}

/**
 * Barbero independiente: los datos de su negocio más su perfil de barbero. El perfil se crea
 * vinculado a la cuenta y activo; la atención a domicilio está fuera de alcance.
 */
export class CreateIndependentDto extends CreateBarbershopDto {
  @ApiPropertyOptional({
    description: 'Nombre visible como barbero. Por defecto, el de la cuenta.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  displayName?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(500)
  bio?: string | null;
}

/**
 * RF-BAR-003. Todos opcionales; los no enviados no cambian. Los campos obligatorios no se
 * pueden vaciar (`null` se rechaza en el servicio).
 */
export class UpdateBarbershopDto extends PartialType(CreateBarbershopDto) {}

/** RF-BAR-004: el responsable solo alterna entre OPEN y TEMPORARILY_CLOSED. */
export class UpdateBarbershopStatusDto {
  @ApiProperty({ enum: ['OPEN', 'TEMPORARILY_CLOSED'] })
  @IsIn(['OPEN', 'TEMPORARILY_CLOSED'])
  status!: 'OPEN' | 'TEMPORARILY_CLOSED';

  @ApiPropertyOptional({ description: 'Solo con TEMPORARILY_CLOSED.' })
  @ValidateIf(
    (o: UpdateBarbershopStatusDto) => o.status === 'TEMPORARILY_CLOSED' && o.reason !== undefined,
  )
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  reason?: string;

  @ApiPropertyOptional({
    description: 'Fecha estimada de reapertura (futura). Solo con TEMPORARILY_CLOSED.',
  })
  @ValidateIf(
    (o: UpdateBarbershopStatusDto) =>
      o.status === 'TEMPORARILY_CLOSED' && o.expectedReopenAt !== undefined,
  )
  @Type(() => Date)
  @IsDate()
  expectedReopenAt?: Date;
}

// ───────────── Respuestas ─────────────

export class MoneyDto {
  @ApiProperty({ example: 2500, description: 'Céntimos.' })
  amount!: number;

  @ApiProperty({ example: 'PEN' })
  currency!: string;
}

export class ClosureDto {
  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ nullable: true, type: Date })
  expectedReopenAt!: Date | null;
}

export class LinksDto {
  @ApiProperty({ nullable: true, type: String })
  website!: string | null;

  @ApiProperty({ nullable: true, type: String })
  instagram!: string | null;

  @ApiProperty({ nullable: true, type: String })
  facebook!: string | null;
}

export class RatingDto {
  @ApiProperty({ example: 4.5 })
  average!: number;

  @ApiProperty({ example: 12 })
  count!: number;
}

/** RF-BAR-002: solo datos públicos. */
export class BarbershopPublicDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty()
  address!: string;

  @ApiProperty()
  latitude!: number;

  @ApiProperty()
  longitude!: number;

  @ApiProperty({ example: DEFAULT_TIMEZONE })
  timezone!: string;

  @ApiProperty({
    enum: BarbershopType,
    enumName: 'BarbershopType',
    description: 'BARBERSHOP: barbería. INDEPENDENT: barbero independiente (un solo barbero).',
  })
  type!: BarbershopType;

  @ApiProperty({ nullable: true, type: String, description: 'Teléfono del negocio.' })
  phone!: string | null;

  @ApiProperty({ enum: BarbershopStatus, enumName: 'BarbershopStatus' })
  status!: BarbershopStatus;

  @ApiProperty({ type: ClosureDto, nullable: true })
  closure!: ClosureDto | null;

  @ApiProperty({ type: LinksDto })
  links!: LinksDto;

  @ApiProperty({ type: RatingDto })
  rating!: RatingDto;

  @ApiProperty({
    description: 'Fase 11: si es favorita de la cuenta que consulta. Sin sesión, siempre false.',
  })
  isFavorite!: boolean;
}

export class BarbershopManageDto extends BarbershopPublicDto {
  @ApiProperty({ nullable: true, type: String })
  ruc!: string | null;

  @ApiProperty({ enum: BarbershopMemberRole, enumName: 'BarbershopMemberRole' })
  myRole!: BarbershopMemberRole;

  @ApiProperty()
  createdAt!: Date;
}

export class CreatedBarbershopDto extends BarbershopManageDto {
  @ApiProperty({
    description:
      'true si se agregó el rol OWNER a la cuenta: renueva el token para verlo reflejado en él.',
  })
  ownerRoleGranted!: boolean;
}

export class CreatedIndependentDto extends CreatedBarbershopDto {
  @ApiProperty({ format: 'uuid', description: 'Perfil de barbero creado y vinculado a la cuenta.' })
  barberId!: string;

  @ApiProperty({
    description: 'true si se agregó el rol BARBER a la cuenta: renueva el token para verlo.',
  })
  barberRoleGranted!: boolean;
}

export class MyBarbershopDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: BarbershopType, enumName: 'BarbershopType' })
  type!: BarbershopType;

  @ApiProperty({ enum: BarbershopStatus, enumName: 'BarbershopStatus' })
  status!: BarbershopStatus;

  @ApiProperty({ enum: BarbershopMemberRole, enumName: 'BarbershopMemberRole' })
  myRole!: BarbershopMemberRole;
}

export class MyBarbershopPageDto {
  @ApiProperty({ type: [MyBarbershopDto] })
  items!: MyBarbershopDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
