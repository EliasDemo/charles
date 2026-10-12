import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { AuthTokensDto } from '../dto/auth.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class MfaStatusDto {
  @ApiProperty({ description: 'La verificación en dos pasos está activa.' })
  enabled!: boolean;

  @ApiProperty({
    description: 'Es personal (SUPPORT o ADMIN): la necesita para la administración.',
  })
  required!: boolean;

  @ApiProperty({ description: 'Esta sesión ya pasó el segundo factor (sesión de personal).' })
  sessionVerified!: boolean;

  @ApiProperty()
  recoveryCodesRemaining!: number;
}

export class MfaSetupDto {
  @ApiProperty({
    description: 'Secreto en base32, para escribirlo a mano si no se puede escanear el QR.',
  })
  secret!: string;

  @ApiProperty({ description: 'URI `otpauth://totp/…` para mostrar como código QR.' })
  otpauthUri!: string;
}

export class MfaCodeDto {
  @ApiProperty({ minLength: 6, maxLength: 6, example: '123456' })
  @Transform(trim)
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class MfaVerifyDto {
  @ApiPropertyOptional({ minLength: 6, maxLength: 6, example: '123456' })
  @ValidateIf((o: MfaVerifyDto) => o.recoveryCode === undefined)
  @Transform(trim)
  @IsString()
  @Matches(/^\d{6}$/)
  code?: string;

  @ApiPropertyOptional({
    example: 'ABCD-EFGH',
    description: 'Código de recuperación (un solo uso), si no se tiene el teléfono.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(8, 12)
  recoveryCode?: string;
}

export class MfaEnabledDto {
  @ApiProperty({
    type: [String],
    description:
      'Códigos de recuperación (un solo uso). Se muestran **una sola vez**: hay que guardarlos.',
  })
  recoveryCodes!: string[];

  @ApiProperty({ type: AuthTokensDto, description: 'Sesión de personal (con segundo factor).' })
  tokens!: AuthTokensDto;
}

export class MfaRecoveryCodesDto {
  @ApiProperty({ type: [String] })
  recoveryCodes!: string[];
}
