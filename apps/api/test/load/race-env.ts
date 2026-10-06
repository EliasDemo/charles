// Entorno de la prueba de carga: misma configuración que las e2e, pero en una base y una base de
// Redis propias, para correr en paralelo con la suite e2e sin que su limpieza (TRUNCATE) la afecte.
import '../support/load-test-env';

export function raceDatabaseUrl(testUrl: string): string {
  return testUrl.replace(/\/charles_test(\?|$)/, '/charles_race$1');
}

process.env.DATABASE_URL = raceDatabaseUrl(process.env.DATABASE_URL ?? '');
process.env.REDIS_URL = (process.env.REDIS_URL ?? '').replace(/\/\d+$/, '/3');
if (process.env.RACE_POOL_MAX) process.env.DATABASE_POOL_MAX = process.env.RACE_POOL_MAX;
