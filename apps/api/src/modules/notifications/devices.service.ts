import { HttpStatus, Injectable } from '@nestjs/common';
import { BlindIndexKind, EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { SettingKey, SettingsService } from '../settings/settings.service';
import type { DeviceDto, RegisterDeviceDto } from './dto/notification.dto';

export const MAX_DEVICES_DEFAULT = 10;

export interface DeviceTarget {
  id: string;
  pushToken: string;
}

/**
 * Tokens push de los dispositivos (Fase 10). Se guardan cifrados, con índice ciego para la
 * unicidad; nunca en claro ni en logs. Cada token queda ligado a la sesión que lo registró: al
 * cerrar esa sesión (o todas) se borra. Máximo `notifications.max_devices_per_user` (10) por
 * cuenta: al pasarse, se borran los menos usados.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly settings: SettingsService,
  ) {}

  /** Registrar o actualizar (idempotente por token). Si el token era de otra cuenta, pasa a esta. */
  async register(userId: string, sessionId: string, dto: RegisterDeviceDto): Promise<DeviceDto> {
    const pushTokenHash = this.encryption.blindIndex(dto.pushToken, BlindIndexKind.PUSH_TOKEN);
    const max = await this.settings.positiveInt(
      SettingKey.NOTIFICATIONS_MAX_DEVICES_PER_USER,
      MAX_DEVICES_DEFAULT,
    );
    const device = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.deviceToken.upsert({
        where: { pushTokenHash },
        update: {
          userId,
          sessionId,
          platform: dto.platform,
          appVersion: dto.appVersion ?? null,
          lastSeenAt: new Date(),
        },
        create: {
          userId,
          sessionId,
          platform: dto.platform,
          appVersion: dto.appVersion ?? null,
          pushTokenHash,
          pushTokenEnc: this.encryption.encrypt(dto.pushToken, EncryptedField.DEVICE_PUSH_TOKEN),
        },
      });
      const extra = await tx.deviceToken.findMany({
        where: { userId },
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
        skip: max,
        select: { id: true },
      });
      if (extra.length > 0) {
        await tx.deviceToken.deleteMany({ where: { id: { in: extra.map((d) => d.id) } } });
      }
      return saved;
    });
    return toDto(device);
  }

  async list(userId: string): Promise<DeviceDto[]> {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toDto);
  }

  async remove(userId: string, deviceId: string): Promise<void> {
    const { count } = await this.prisma.deviceToken.deleteMany({
      where: { id: deviceId, userId },
    });
    if (count === 0) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'El dispositivo no existe.',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /** Al cerrar sesiones: sus dispositivos dejan de recibir avisos. */
  async removeForSessions(
    userId: string,
    sessionIds: string[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    if (sessionIds.length === 0) return;
    await tx.deviceToken.deleteMany({ where: { userId, sessionId: { in: sessionIds } } });
  }

  /** Cierre de todas las sesiones (o cuenta deshabilitada): ningún dispositivo queda activo. */
  async removeAllForUser(
    userId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await tx.deviceToken.deleteMany({ where: { userId } });
  }

  /** Expo marcó el token como inválido (`DeviceNotRegistered`). */
  async removeInvalid(deviceIds: string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    await this.prisma.deviceToken.deleteMany({ where: { id: { in: deviceIds } } });
  }

  /** Destinos push de una cuenta, con el token descifrado (solo para el envío). */
  async targets(userId: string): Promise<DeviceTarget[]> {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { id: true, pushTokenEnc: true },
    });
    return rows.map((r) => ({
      id: r.id,
      pushToken: this.encryption.decrypt(r.pushTokenEnc, EncryptedField.DEVICE_PUSH_TOKEN),
    }));
  }
}

function toDto(device: {
  id: string;
  platform: DeviceDto['platform'];
  appVersion: string | null;
  lastSeenAt: Date;
}): DeviceDto {
  return {
    id: device.id,
    platform: device.platform,
    appVersion: device.appVersion,
    lastSeenAt: device.lastSeenAt.toISOString(),
  };
}
