import { Client } from 'pg';
import { loadTestEnv } from '../support/load-test-env';

/** Elimina `charles_race` al terminar (autorización permanente, CLAUDE.md §1 regla 10). */
export default async function globalTeardown(): Promise<void> {
  loadTestEnv();
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'charles_race' AND pid <> pg_backend_pid()",
  );
  await admin.query('DROP DATABASE IF EXISTS charles_race');
  await admin.end();
}
