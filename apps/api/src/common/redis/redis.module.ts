import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/env.validation';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // Si nunca se conectó (lazyConnect), `quit()` abriría una conexión solo para cerrarla.
    if (this.redis.status === 'wait') this.redis.disconnect();
    else if (this.redis.status !== 'end') await this.redis.quit();
  }
}

/** Cliente Redis compartido. Conecta en el primer uso (`lazyConnect`). */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis =>
        new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 }),
    },
    RedisShutdown,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
