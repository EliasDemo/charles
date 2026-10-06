import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AdminGrantError, type GrantableRole, grantRoleFromConsole } from './admin-grant-tool';

/**
 * `pnpm --filter api admin:grant <correo> [--role admin|support]` (por defecto admin).
 * Se ejecuta en el servidor; nunca es un endpoint. Queda auditado.
 */
const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const roleFlag = args.indexOf('--role');
const roleArg = roleFlag >= 0 ? args[roleFlag + 1] : 'admin';
if (!email || (roleArg !== 'admin' && roleArg !== 'support')) {
  console.error('Uso: pnpm --filter api admin:grant <correo> [--role admin|support]');
  process.exit(1);
}
const role: GrantableRole = roleArg === 'admin' ? 'ADMIN' : 'SUPPORT';

void (async () => {
  process.env.SCHEDULED_JOBS_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const result = await grantRoleFromConsole(app, email, role);
    console.warn(
      result.alreadyHadRole
        ? `La cuenta ${result.userId} ya tenía el rol ${role}.`
        : `Rol ${role} asignado a la cuenta ${result.userId}. Debe renovar su sesión.`,
    );
  } catch (error) {
    console.error(
      error instanceof AdminGrantError ? error.message : `Error: ${(error as Error).message}`,
    );
    process.exitCode = 1;
  } finally {
    await app.close();
  }
})();
