import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './common/config/app-config.module';
import { APP_CONFIG } from './common/config/app-config.token';
import type { AppConfig } from './common/config/env.validation';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { HealthModule } from './common/health/health.module';
import { HttpsOnlyMiddleware } from './common/http/https-only.middleware';
import { buildLoggerParams } from './common/logging/logger.options';
import { PrismaModule } from './common/prisma/prisma.module';
import { REDIS_CLIENT, RedisModule } from './common/redis/redis.module';
import { ClientIpThrottlerGuard } from './common/throttling/client-ip-throttler.guard';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildLoggerParams(config),
    }),
    PrismaModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG, REDIS_CLIENT],
      useFactory: (config: AppConfig, redis: Redis) => ({
        throttlers: [{ name: 'default', ttl: config.throttle.ttlMs, limit: config.throttle.limit }],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpsOnlyMiddleware).forRoutes('{*path}');
  }
}
