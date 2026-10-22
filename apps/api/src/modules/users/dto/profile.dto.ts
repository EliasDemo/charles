import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Gender, NotificationChannel, Role } from '../../../generated/prisma/enums';
import { FACE_SHAPES, type FaceShape } from '../../recommendations/face-shape';
import { USERNAME_PATTERN } from '../username';

/** Fecha de calendario `YYYY-MM-DD` (la validez real y la edad se comprueban en el servicio). */
export const BIRTH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Teléfono en formato libre razonable: dígitos, espacios, guiones, paréntesis y "+" inicial. */
export const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,19}$/;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class NotificationPreferencesDto {
  @ApiProperty({ enum: NotificationChannel, enumName: 'NotificationChannel', isArray: true })
  @IsArray()
  @ArrayUnique()
  @IsEnum(NotificationChannel, { each: true })
  notificationChannels!: NotificationChannel[];

  @ApiPropertyOptional({
    default: true,
    description: 'Fase 10: recordatorios de citas (24 y 2 h antes). Por defecto activos.',
  })
  @IsOptional()
  @IsBoolean()
  reminders?: boolean;
}

/** RF-CLI-002: nombre, teléfono, preferencias, fecha de nacimiento y género. El correo no se cambia. */
export class UpdateProfileDto {
  @ApiPropertyOptional({
    example: 'ana.perez',
    description: `Cambiar el nombre de usuario (una vez cada 30 días).`,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(USERNAME_PATTERN)
  username?: string;

  @ApiPropertyOptional({ example: 'Ana Pérez' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional({
    type: String,
    example: '+51 987 654 321',
    nullable: true,
    description: 'null lo elimina',
  })
  @ValidateIf((_o, value) => value !== null && value !== undefined)
  @Transform(trim)
  @IsString()
  @Matches(PHONE_PATTERN)
  phone?: string | null;

  @ApiPropertyOptional({ type: NotificationPreferencesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationPreferencesDto)
  preferences?: NotificationPreferencesDto;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '1995-04-23',
    nullable: true,
    description:
      'YYYY-MM-DD; fecha real, desde 1900 y con 18 años cumplidos (la app es para mayores de ' +
      'edad). null la elimina. Se guarda cifrada y nunca la ven las barberías.',
  })
  @ValidateIf((_o, value) => value !== null && value !== undefined)
  @IsString()
  @Matches(BIRTH_DATE_PATTERN)
  birthDate?: string | null;

  @ApiPropertyOptional({
    enum: Gender,
    enumName: 'Gender',
    nullable: true,
    description: 'null lo elimina. Solo para sugerir estilos; nunca lo ven las barberías.',
  })
  @ValidateIf((_o, value) => value !== null && value !== undefined)
  @IsEnum(Gender)
  gender?: Gender | null;

  @ApiPropertyOptional({
    enum: FACE_SHAPES,
    enumName: 'FaceShape',
    nullable: true,
    type: String,
    description:
      'Recordar mi forma de cara (dato biométrico): exige faceShapeConsent=true. null la borra.',
  })
  @ValidateIf((_o, value) => value !== null && value !== undefined)
  @IsIn(FACE_SHAPES)
  faceShape?: FaceShape | null;

  @ApiPropertyOptional({
    description:
      'Consentimiento expreso para guardar la forma de cara (obligatorio para guardarla).',
  })
  @IsOptional()
  @IsBoolean()
  faceShapeConsent?: boolean;
}

export class ProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'ana.perez', description: 'Público (lo ven otras personas).' })
  username!: string;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'Desde cuándo puede volver a cambiar el usuario (null: ya puede).',
  })
  usernameChangeableAt!: Date | null;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ enum: Role, enumName: 'Role', isArray: true })
  roles!: Role[];

  @ApiProperty({ type: NotificationPreferencesDto })
  preferences!: NotificationPreferencesDto;

  @ApiProperty({ type: String, format: 'date', nullable: true, example: '1995-04-23' })
  birthDate!: string | null;

  @ApiProperty({ enum: Gender, enumName: 'Gender', nullable: true })
  gender!: Gender | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Foto de perfil (cuadrado de 512 px, WebP). null si no tiene.',
  })
  photoUrl!: string | null;

  @ApiProperty({
    enum: FACE_SHAPES,
    enumName: 'FaceShape',
    nullable: true,
    type: String,
    description: 'Forma de cara guardada (solo si la persona lo autorizó).',
  })
  faceShape!: FaceShape | null;

  @ApiProperty()
  createdAt!: Date;
}

/** Foto de perfil tras subirla o quitarla. */
export class ProfilePhotoDto {
  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;
}
