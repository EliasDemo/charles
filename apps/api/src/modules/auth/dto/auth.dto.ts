import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { Role } from '../../../generated/prisma/enums';
import { PHONE_PATTERN } from '../../users/dto/profile.dto';
import {
  IsNotCommonPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../password/password-policy';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Código de un solo uso: exactamente 6 dígitos. */
const CODE_PATTERN = /^\d{6}$/;

export class RegisterDto {
  @ApiProperty({ example: 'Ana Pérez' })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  fullName!: string;

  @ApiProperty({ example: 'ana@example.com' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  @IsNotCommonPassword()
  password!: string;

  @ApiPropertyOptional({ example: '+51 987 654 321' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(PHONE_PATTERN)
  phone?: string;

  @ApiProperty({ description: 'Debe ser true: acepta los términos y condiciones.' })
  @IsBoolean()
  @Equals(true)
  acceptTerms!: boolean;

  @ApiProperty({ description: 'Debe ser true: declara tener 18 años o más (ADR 0003).' })
  @IsBoolean()
  @Equals(true)
  declaresAdult!: boolean;

  @ApiProperty({ description: 'Versión de los términos que el usuario aceptó (GET /auth/terms).' })
  @IsString()
  @MaxLength(50)
  termsVersion!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'ana@example.com' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Sin la política de longitud: un error aquí no debe dar pistas sobre la cuenta. */
  @ApiProperty()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({ example: 'iPhone de Ana', description: 'Nombre del dispositivo.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}

export class LogoutDto {
  @ApiPropertyOptional({ description: 'true cierra la sesión en todos los dispositivos.' })
  @IsOptional()
  @IsBoolean()
  allDevices?: boolean;
}

export class PasswordResetRequestDto {
  @ApiProperty({ example: 'ana@example.com' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class PasswordResetConfirmDto {
  @ApiProperty({ example: 'ana@example.com' })
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(CODE_PATTERN)
  code!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  @IsNotCommonPassword()
  newPassword!: string;
}

export class EmailVerificationConfirmDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(CODE_PATTERN)
  code!: string;
}

// ───────────── Respuestas ─────────────

export class AcceptedResponseDto {
  @ApiProperty()
  message!: string;
}

export class TermsDto {
  @ApiProperty({ example: '2026-10' })
  version!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://charles.example/terminos',
    description: 'Términos y condiciones (legal.terms_url). null si no está configurada.',
  })
  termsUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://charles.example/privacidad',
    description: 'Política de privacidad (legal.privacy_url). null si no está configurada.',
  })
  privacyUrl!: string | null;
}

export class SessionUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ enum: Role, enumName: 'Role', isArray: true })
  roles!: Role[];

  @ApiProperty()
  emailVerified!: boolean;
}

/**
 * Tokens en el cuerpo (apps móviles). La web usará cookies HttpOnly + CSRF en su fase,
 * sin cambiar estos endpoints (pendiente en CLAUDE.md §6.3).
 */
export class AuthTokensDto {
  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  accessTokenExpiresAt!: Date;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty()
  refreshTokenExpiresAt!: Date;

  @ApiProperty({ type: SessionUserDto })
  user!: SessionUserDto;
}

/** Fase 12: acceso restringido de una cuenta deshabilitada (solo sus tickets de soporte). */
export class SupportAccessDto {
  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({ description: 'Solo vale para /support/tickets y /me/support/tickets.' })
  accessToken!: string;

  @ApiProperty()
  accessTokenExpiresAt!: Date;

  @ApiProperty({ example: true })
  restricted!: true;
}
