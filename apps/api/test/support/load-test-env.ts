import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carga `apps/api/.env.test` si existe (entorno local). En CI las variables
 * vienen del entorno. Las variables ya definidas no se sobrescriben.
 */
export function loadTestEnv(): void {
  const file = resolve(__dirname, '../../.env.test');
  if (existsSync(file)) process.loadEnvFile(file);
  process.env.NODE_ENV = 'test';

  // Protección: las e2e limpian datos; nunca deben correr contra otra base.
  const url = process.env.DATABASE_URL ?? '';
  if (!/\/charles_test(\?|$)/.test(url)) {
    throw new Error('Las pruebas e2e requieren DATABASE_URL apuntando a la base charles_test.');
  }
  // Las e2e vacían Redis (FLUSHDB); se exige una base distinta de la 0 (desarrollo).
  if (!/^rediss?:\/\/[^/]+\/([1-9]|1[0-5])$/.test(process.env.REDIS_URL ?? '')) {
    throw new Error('Las pruebas e2e requieren REDIS_URL con una base de Redis distinta de 0.');
  }
}

loadTestEnv();
