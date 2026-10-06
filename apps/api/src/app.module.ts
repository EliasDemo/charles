import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './common/audit/audit.module';
import { AuthCommonModule } from './common/auth/auth-common.module';
import { ClockModule } from './common/clock/clock';
import { AppConfigModule } from './common/config/app-config.module';
import { APP_CONFIG } from './common/config/app-config.token';
import type { AppConfig } from './common/config/env.validation';
import { CryptoModule } from './common/crypto/crypto.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { HealthModule } from './common/health/health.module';
import { HttpsOnlyMiddleware } from './common/http/https-only.middleware';
import { MailModule } from './common/mail/mail.module';
import { buildLoggerParams } from './common/logging/logger.options';
import { PrismaModule } from './common/prisma/prisma.module';
import { QueueModule } from './common/queue/queue.module';
import { REDIS_CLIENT, RedisModule } from './common/redis/redis.module';
import { ClientIpThrottlerGuard } from './common/throttling/client-ip-throttler.guard';
import { AuthModule } from './modules/auth/auth.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { BarbersModule } from './modules/barbers/barbers.module';
import { BarbershopsModule } from './modules/barbershops/barbershops.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { BookingsManagementModule } from './modules/bookings/bookings-management.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SearchModule } from './modules/search/search.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { ServicesModule } from './modules/services/services.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildLoggerParams(config),
    }),
    PrismaModule,
    OutboxModule,
    CryptoModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG, REDIS_CLIENT],
      useFactory: (config: AppConfig, redis: Redis) => ({
        throttlers: [{ name: 'default', ttl: config.throttle.ttlMs, limit: config.throttle.limit }],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
    ClockModule,
    AuditModule,
    QueueModule,
    MailModule,
    AuthCommonModule,
    HealthModule,
    UsersModule,
    AuthModule,
    BarbershopsModule,
    ServicesModule,
    BarbersModule,
    InvitationsModule,
    AvailabilityModule,
    SearchModule,
    PaymentsModule,
    BookingsManagementModule,
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
