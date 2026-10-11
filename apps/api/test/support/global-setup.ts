import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadTestEnv } from './load-test-env';

/** Aplica las migraciones a la base de pruebas antes de ejecutar las e2e. */
export default function globalSetup(): void {
  loadTestEnv();
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(__dirname, '../..'),
    env: process.env,
    stdio: 'inherit',
  });
  // Categorías y estilos de servicio (datos de referencia, idempotente).
  execSync('pnpm exec tsx prisma/seed-reference.ts', {
    cwd: resolve(__dirname, '../..'),
    env: process.env,
    stdio: 'inherit',
  });
}
