import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';

export const SettingKey = {
  TERMS_VERSION: 'legal.terms_version',
  LOCKOUT_ACCOUNT_MAX_FAILURES: 'auth.lockout.account_max_failures',
  LOCKOUT_IP_MAX_FAILURES: 'auth.lockout.ip_max_failures',
  BARBERSHOPS_REQUIRE_REVIEW: 'barbershops.require_review',
  INVITATION_TTL_MINUTES: 'barbershops.invitation_ttl_minutes',
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

  /**
   * Entero positivo configurable. Si la clave no existe o su valor no es válido, se usa
   * `fallback` (el valor decidido en CLAUDE.md), y un valor inválido queda registrado en el log.
   */
  async positiveInt(key: string, fallback: number): Promise<number> {
    const value = await this.get(key);
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (value !== null) this.logger.warn(`Valor inválido en ${key}; se usa ${fallback}`);
    return fallback;
  }

  /** Booleano configurable; `fallback` si la clave no existe o no es booleana. */
  async boolean(key: string, fallback: boolean): Promise<boolean> {
    const value = await this.get(key);
    if (typeof value === 'boolean') return value;
    if (value !== null) this.logger.warn(`Valor inválido en ${key}; se usa ${fallback}`);
    return fallback;
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
