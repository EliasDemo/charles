import { RatingDto } from '../../barbershops/dto/barbershop.dto';
import { BarbershopStatus } from '../../../generated/prisma/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { PHONE_PATTERN } from '../../users/dto/profile.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const emptyToNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === '' ? null : trim({ value });

class BarberProfileFieldsDto {
  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  bio?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'Dato personal: se guarda cifrado y nunca es público.',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(PHONE_PATTERN)
  phone?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Servicios de la barbería que realiza.' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  serviceIds?: string[];
}

/** RF-BRB-001: perfil de barbero creado por el responsable (sin cuenta vinculada). */
export class CreateBarberDto extends BarberProfileFieldsDto {
  @ApiProperty({ example: 'Carlos' })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  displayName!: string;
}

/** El responsable que también es barbero se vincula a sí mismo (sin invitación). */
export class LinkSelfAsBarberDto extends BarberProfileFieldsDto {
  @ApiPropertyOptional({ description: 'Por defecto, el nombre de la cuenta.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  displayName?: string;
}

/** RF-BRB-002. Los servicios se cambian con PUT …/services. */
export class UpdateBarberDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  displayName?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  bio?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(PHONE_PATTERN)
  phone?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 0,
    maximum: 60,
    description: 'Años de experiencia (Fase 14). null lo quita.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(60)
  yearsExperience?: number | null;

  @ApiPropertyOptional({ description: 'false lo desactiva (rechazado si tiene reservas futuras).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetBarberServicesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  serviceIds!: string[];
}

export class InviteBarberDto {
  @ApiProperty({ example: 'barbero@example.com', description: 'Correo de una cuenta existente.' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

// ───────────── Respuestas ─────────────

/** Estilo del catálogo (Fase 14), en forma resumida. */
export class StyleRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'fade_low' })
  key!: string;

  @ApiProperty({ example: 'Degradado bajo' })
  name!: string;
}

/** Datos públicos: nunca el teléfono ni la cuenta vinculada. */
export class BarberPublicDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'Carrera del barbero: su perfil profesional (GET /barber-profiles/{id}). null si no tiene cuenta.',
  })
  profileId!: string | null;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ nullable: true, type: String })
  bio!: string | null;

  @ApiProperty({ nullable: true, type: String })
  photoUrl!: string | null;

  @ApiProperty({ type: [String] })
  serviceIds!: string[];

  @ApiProperty({ nullable: true, type: Number, description: 'Años de experiencia (Fase 14).' })
  yearsExperience!: number | null;

  @ApiProperty({
    type: () => [StyleRefDto],
    description: 'Especialidades (hasta 5 estilos), en el orden del catálogo.',
  })
  specialties!: StyleRefDto[];

  @ApiProperty({ type: RatingDto, description: 'Valoraciones visibles del barbero (Fase 11).' })
  rating!: RatingDto;
}

export class LinkedUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

export class BarberManageDto extends BarberPublicDto {
  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ type: LinkedUserDto, nullable: true })
  linkedUser!: LinkedUserDto | null;
}

export class BarberPublicPageDto {
  @ApiProperty({ type: [BarberPublicDto] })
  items!: BarberPublicDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class BarberManagePageDto {
  @ApiProperty({ type: [BarberManageDto] })
  items!: BarberManageDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class MyBarberShopDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: BarbershopStatus, enumName: 'BarbershopStatus' })
  status!: BarbershopStatus;

  @ApiProperty({ example: 'America/Lima' })
  timezone!: string;
}

/** Perfil de barbero propio (para la app: bloqueos propios, agenda). */
export class MyBarberProfileDto {
  @ApiProperty({ format: 'uuid' })
  barberId!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ description: 'Solo un perfil activo a la vez (MVP).' })
  isActive!: boolean;

  @ApiProperty({ type: [String], description: 'Servicios que realiza.' })
  serviceIds!: string[];

  @ApiProperty({ type: MyBarberShopDto })
  barbershop!: MyBarberShopDto;
}

export class MyBarberProfilesDto {
  @ApiProperty({
    type: [MyBarberProfileDto],
    description: 'Vacío si la cuenta no está vinculada a ningún perfil de barbero.',
  })
  items!: MyBarberProfileDto[];
}
