import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination';
import { DevicePlatform } from '../../../generated/prisma/enums';

/** Token de Expo: `ExponentPushToken[...]` o `ExpoPushToken[...]`. */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ───────────── Dispositivos ─────────────

/** El token va en el cuerpo, nunca en la URL; no se escribe en los logs. */
export class RegisterDeviceDto {
  @ApiProperty({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' })
  @Transform(trim)
  @IsString()
  @Matches(EXPO_PUSH_TOKEN, { message: 'pushToken no es un token de Expo válido' })
  pushToken!: string;

  @ApiProperty({ enum: [DevicePlatform.IOS, DevicePlatform.ANDROID] })
  @IsEnum([DevicePlatform.IOS, DevicePlatform.ANDROID])
  platform!: DevicePlatform;

  @ApiPropertyOptional({ example: '1.4.0', maxLength: 40 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  @Matches(/^[0-9A-Za-z.+-]+$/)
  appVersion?: string;
}

export class DeviceDto {
  @ApiProperty({ format: 'uuid', description: 'ID propio del dispositivo (para borrarlo).' })
  id!: string;

  @ApiProperty({ enum: DevicePlatform })
  platform!: DevicePlatform;

  @ApiProperty({ nullable: true, type: String })
  appVersion!: string | null;

  @ApiProperty({ format: 'date-time' })
  lastSeenAt!: string;
}

export class DeviceListDto {
  @ApiProperty({ type: [DeviceDto] })
  items!: DeviceDto[];
}

// ───────────── Bandeja ─────────────

export class NotificationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Type(() => String)
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  unreadOnly?: boolean;
}

export class NotificationResourceDto {
  @ApiProperty({
    enum: [
      'booking',
      'review',
      'ticket',
      'barbershop',
      'account',
      'conversation',
      'job_application',
    ],
    description: 'Pantalla que abre la app al tocar el aviso.',
  })
  type!: string;

  @ApiProperty({ nullable: true, type: String })
  id!: string | null;
}

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'BOOKING_CONFIRMED' })
  type!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ type: NotificationResourceDto })
  resource!: NotificationResourceDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  readAt!: string | null;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto] })
  items!: NotificationDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class UnreadCountDto {
  @ApiProperty()
  unread!: number;
}

export class MarkedReadDto {
  @ApiProperty()
  updated!: number;
}
