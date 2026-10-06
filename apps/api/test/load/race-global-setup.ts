import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { loadTestEnv } from '../support/load-test-env';

/** Crea `charles_race` si no existe y le aplica las migraciones y los datos de referencia. */
export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  const testUrl = process.env.DATABASE_URL ?? '';
  const admin = new Client({ connectionString: testUrl });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'charles_race'");
  if (exists.rowCount === 0) await admin.query('CREATE DATABASE charles_race');
  await admin.end();
  const env = {
    ...process.env,
    DATABASE_URL: testUrl.replace(/\/charles_test(\?|$)/, '/charles_race$1'),
  };
  const cwd = resolve(__dirname, '../..');
  execSync('pnpm exec prisma migrate deploy', { cwd, env, stdio: 'inherit' });
  execSync('pnpm exec tsx prisma/seed-reference.ts', { cwd, env, stdio: 'inherit' });
}
