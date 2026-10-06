import type { INestApplicationContext } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { UsersService } from '../modules/users/users.service';

export class AdminGrantError extends Error {}

export type GrantableRole = 'ADMIN' | 'SUPPORT';

/**
 * `admin:grant` (Fase 12): asigna ADMIN o SUPPORT desde la consola del servidor. Es la forma de
 * crear el primer ADMIN; **nunca** existe como endpoint. Queda en `audit_log` sin actor
 * (`via: console`). Después, los roles se administran desde `/admin` por un ADMIN.
 */
export async function grantRoleFromConsole(
  app: INestApplicationContext,
  email: string,
  role: GrantableRole,
): Promise<{ userId: string; alreadyHadRole: boolean }> {
  const users = app.get(UsersService);
  const userId = await users.findIdByEmailHash(users.emailHash(email.trim()));
  const user = userId ? await users.findCredentialsById(userId) : null;
  if (!userId || !user || user.isDeleted) {
    throw new AdminGrantError('No existe una cuenta con ese correo.');
  }
  if (user.status !== 'ACTIVE') {
    throw new AdminGrantError(
      'La cuenta está deshabilitada; reactívala antes de asignarle un rol.',
    );
  }
  const alreadyHadRole = user.roles.includes(role);
  await app.get(PrismaService).$transaction(async (tx) => {
    await users.addRole(userId, role, tx);
    await app.get(AuditService).record(
      {
        actorId: null,
        action: 'role.granted',
        entityType: 'user',
        entityId: userId,
        changes: { role, via: 'console', alreadyHadRole },
      },
      tx,
    );
  });
  return { userId, alreadyHadRole };
}
