import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type Redis from 'ioredis';
import type { AuthenticatedRequest } from '../../common/auth/auth-user';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { ConfigurableLimit } from '../../common/throttling/rate-limit.decorator';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { IMAGE_DEFAULTS } from './image-policy';

export const IMAGE_UPLOAD_RATE_LIMIT = new ConfigurableLimit(
  IMAGE_DEFAULTS.uploadRateLimitPerMinute,
);
const WINDOW_SECONDS = 60;

/**
 * Límite propio por **cuenta** para subir imágenes (`images.upload_rate_limit_per_minute`, 20).
 * Va como guard del método, después de la autenticación. El límite global por IP sigue aplicando.
 */
@Injectable()
export class ImageUploadRateLimitGuard implements CanActivate {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest<AuthenticatedRequest>().user?.id;
    if (!userId) return true; // sin sesión responde el guard de autenticación
    const window = Math.floor(this.clock.now() / (WINDOW_SECONDS * 1000));
    const key = `rl:images:upload:${userId}:${window}`;
    const [[, count]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, WINDOW_SECONDS * 2)
      .exec()) as [[Error | null, number], [Error | null, number]];
    if (count > IMAGE_UPLOAD_RATE_LIMIT.value) {
      throw new AppException(
        ErrorCode.TOO_MANY_REQUESTS,
        'Demasiadas subidas. Espera un momento e inténtalo de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

/** Relee el límite cada minuto (sin consultar la base en cada petición). */
@Injectable()
export class ImageRateLimitRefresher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImageRateLimitRefresher.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly settings: SettingsService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      IMAGE_UPLOAD_RATE_LIMIT.set(
        await this.settings.positiveInt(
          SettingKey.IMAGES_UPLOAD_RATE_LIMIT_PER_MINUTE,
          IMAGE_DEFAULTS.uploadRateLimitPerMinute,
        ),
      );
    } catch {
      this.logger.warn('No se pudo leer el límite de subidas de imágenes; se mantiene el anterior');
    }
  }
}
