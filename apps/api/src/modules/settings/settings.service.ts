import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';

export const SettingKey = {
  TERMS_VERSION: 'legal.terms_version',
} as const;

/** Lectura de `app_settings` (clave/valor). Las políticas pendientes valen JSON `null`. */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(key: string): Promise<unknown> {
    const setting = await this.prisma.appSetting.findUnique({ where: { key } });
    return setting?.value ?? null;
  }

  /** Versión vigente de los términos y condiciones (CLAUDE.md §4.1). */
  async termsVersion(): Promise<string> {
    const value = await this.get(SettingKey.TERMS_VERSION);
    if (typeof value !== 'string' || value.length === 0) {
      this.logger.error(`Falta configurar ${SettingKey.TERMS_VERSION} en app_settings`);
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'El servicio no está disponible temporalmente.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return value;
  }
}
