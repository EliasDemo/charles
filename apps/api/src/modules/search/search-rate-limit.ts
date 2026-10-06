import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  SEARCH_RATE_LIMIT,
  SEARCH_RATE_LIMIT_DEFAULT,
} from '../../common/throttling/rate-limit.decorator';
import { SettingKey, SettingsService } from '../settings/settings.service';

const REFRESH_MS = 60_000;

/**
 * Mantiene `SEARCH_RATE_LIMIT` al día con `search.rate_limit_per_minute`: lo lee al iniciar y
 * cada minuto (el throttler no consulta la base en cada petición).
 */
@Injectable()
export class SearchRateLimitRefresher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchRateLimitRefresher.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly settings: SettingsService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      SEARCH_RATE_LIMIT.set(
        await this.settings.positiveInt(
          SettingKey.SEARCH_RATE_LIMIT_PER_MINUTE,
          SEARCH_RATE_LIMIT_DEFAULT,
        ),
      );
    } catch {
      this.logger.warn('No se pudo leer el límite de búsqueda; se mantiene el anterior');
    }
  }
}
