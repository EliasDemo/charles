import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { assertNotProduction, DevToolError } from './dev-tools';

/**
 * Arranca la aplicación **sin servidor HTTP** para una herramienta de desarrollo y la cierra al
 * terminar. Los trabajos programados se apagan (la herramienta no debe procesar colas).
 */
export async function runDevTool(
  run: (app: INestApplicationContext) => Promise<void>,
): Promise<void> {
  try {
    assertNotProduction(process.env.NODE_ENV);
    process.env.SCHEDULED_JOBS_ENABLED = 'false';
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      await run(app);
    } finally {
      await app.close();
    }
  } catch (error) {
    console.error(
      error instanceof DevToolError ? error.message : `Error: ${(error as Error).message}`,
    );
    process.exitCode = 1;
  }
}
