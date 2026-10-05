import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/env.validation';

/** Traduce REDIS_URL a opciones de conexión de BullMQ (que gestiona sus propias conexiones). */
export function bullConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = Number(url.pathname.replace('/', '') || '0');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // Requisito de BullMQ para los workers.
    maxRetriesPerRequest: null,
  };
}

/** Colas y tareas en segundo plano (Redis + BullMQ, CLAUDE.md §2). */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: bullConnection(config.redisUrl),
        prefix: 'charles:bull',
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      }),
    }),
  ],
})
export class QueueModule {}
