import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { NotificationChannel, Role } from '../../../generated/prisma/enums';

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
}

/** RF-CLI-002: solo nombre, teléfono y preferencias. El correo no se puede cambiar en el MVP. */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Ana Pérez' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional({
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
}

export class ProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

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

  @ApiProperty()
  createdAt!: Date;
}
