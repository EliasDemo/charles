import type { ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { CLOCK, type Clock } from '../../src/common/clock/clock';
import { APP_CONFIG } from '../../src/common/config/app-config.token';
import { type AppConfig, validateEnv } from '../../src/common/config/env.validation';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { configureApp } from '../../src/configure-app';
import { TestProbeModule } from './test-probe.module';

interface TestAppOptions {
  config?: Partial<AppConfig>;
  imports?: ModuleMetadata['imports'];
  /** Reloj fijo o controlable (por defecto, el del sistema). */
  clock?: Clock;
}

/** Levanta la app completa (igual que `main.ts`) con los endpoints de prueba. */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, TestProbeModule, ...(options.imports ?? [])],
  })
    .overrideProvider(APP_CONFIG)
    .useFactory({ factory: (): AppConfig => ({ ...validateEnv(process.env), ...options.config }) })
    .overrideProvider(CLOCK)
    .useValue(options.clock ?? { now: () => Date.now() })
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}

/** Borra los contadores del límite de peticiones (base Redis de pruebas). */
export async function flushRedis(app: NestExpressApplication): Promise<void> {
  await app.get<Redis>(REDIS_CLIENT).flushdb();
}
