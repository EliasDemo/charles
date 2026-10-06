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

export const BOOKING_RATE_LIMIT_DEFAULT = 20;
export const BOOKING_RATE_LIMIT = new ConfigurableLimit(BOOKING_RATE_LIMIT_DEFAULT);
const WINDOW_SECONDS = 60;

/**
 * Límite por **cliente** (no por IP) para crear reservas: `booking.rate_limit_per_minute` (20).
 * Va como guard del método, así corre después de la autenticación y conoce al usuario. El límite
 * global por IP sigue aplicando.
 */
@Injectable()
export class BookingCreationRateLimitGuard implements CanActivate {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest<AuthenticatedRequest>().user?.id;
    if (!userId) return true; // sin sesión responde el guard de autenticación
    const window = Math.floor(this.clock.now() / (WINDOW_SECONDS * 1000));
    const key = `rl:bookings:create:${userId}:${window}`;
    const [[, count]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, WINDOW_SECONDS * 2)
      .exec()) as [[Error | null, number], [Error | null, number]];
    if (count > BOOKING_RATE_LIMIT.value) {
      throw new AppException(
        ErrorCode.TOO_MANY_REQUESTS,
        'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

/** Relee el límite cada minuto (sin consultar la base en cada petición). */
@Injectable()
export class BookingRateLimitRefresher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingRateLimitRefresher.name);
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
      BOOKING_RATE_LIMIT.set(
        await this.settings.positiveInt(
          SettingKey.BOOKING_RATE_LIMIT_PER_MINUTE,
          BOOKING_RATE_LIMIT_DEFAULT,
        ),
      );
    } catch {
      this.logger.warn('No se pudo leer el límite de reservas; se mantiene el anterior');
    }
  }
}
