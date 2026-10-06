import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { ConfigurableLimit } from '../../common/throttling/rate-limit.decorator';
import { SettingKey, SettingsService } from '../settings/settings.service';

export const WEBHOOK_RATE_LIMIT_DEFAULT = 600;
export const WEBHOOK_RATE_LIMIT = new ConfigurableLimit(WEBHOOK_RATE_LIMIT_DEFAULT);
/** Avisos con firma inválida tolerados por IP y minuto antes de responder 429. */
export const INVALID_WEBHOOKS_PER_IP = 30;
const WINDOW_SECONDS = 60;

const tooMany = (): AppException =>
  new AppException(
    ErrorCode.TOO_MANY_REQUESTS,
    'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.',
    HttpStatus.TOO_MANY_REQUESTS,
  );

/**
 * Límite de los webhooks de la pasarela (Fase 8A). El proveedor envía todos sus avisos desde
 * pocas direcciones, así que el límite no puede depender solo de la IP:
 * - Avisos con firma válida: cupo **por proveedor**, `payments.webhook_rate_limit_per_minute`
 *   (600). Solo un aviso auténtico consume el cupo del proveedor.
 * - Avisos con firma inválida: cupo **por IP** (30/min). Quien falsifica avisos se bloquea a sí
 *   mismo sin agotar el cupo del proveedor.
 * La ruta omite el límite global por IP.
 */
@Injectable()
export class WebhookRateLimiter {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Antes de verificar la firma: rechaza una IP que ya envió demasiados avisos inválidos. */
  async assertIpNotBlocked(ip: string): Promise<void> {
    const count = Number(await this.redis.get(this.key('invalid', ip)));
    if (count >= INVALID_WEBHOOKS_PER_IP) throw tooMany();
  }

  async recordInvalid(ip: string): Promise<void> {
    await this.increment(this.key('invalid', ip));
  }

  /** Después de verificar la firma: consume el cupo del proveedor. */
  async consumeProvider(provider: string): Promise<void> {
    const count = await this.increment(this.key('provider', provider));
    if (count > WEBHOOK_RATE_LIMIT.value) throw tooMany();
  }

  private key(kind: 'invalid' | 'provider', id: string): string {
    const window = Math.floor(this.clock.now() / (WINDOW_SECONDS * 1000));
    return `rl:webhooks:${kind}:${id}:${window}`;
  }

  private async increment(key: string): Promise<number> {
    const [[, count]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, WINDOW_SECONDS * 2)
      .exec()) as [[Error | null, number], [Error | null, number]];
    return count;
  }
}

/** Relee el límite cada minuto (sin consultar la base en cada aviso). */
@Injectable()
export class WebhookRateLimitRefresher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookRateLimitRefresher.name);
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
      WEBHOOK_RATE_LIMIT.set(
        await this.settings.positiveInt(
          SettingKey.WEBHOOK_RATE_LIMIT_PER_MINUTE,
          WEBHOOK_RATE_LIMIT_DEFAULT,
        ),
      );
    } catch {
      this.logger.warn('No se pudo leer el límite de webhooks; se mantiene el anterior');
    }
  }
}
