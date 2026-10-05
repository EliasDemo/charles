import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateEnv } from '../../src/common/config/env.validation';
import { BlindIndexKind, EncryptedField } from '../../src/common/crypto/encryption-contexts';
import { EncryptionService } from '../../src/common/crypto/encryption.service';
import { StaticKeyProvider } from '../../src/common/crypto/key-provider';
import { PasswordHasher } from '../../src/common/crypto/password-hasher';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';
import { SEED_SETTINGS, SEED_USERS, seed } from '../../prisma/seed/seed';
import { createTestPrisma, truncateAll } from '../support/db';

describe('Esquema y migraciones (integración, charles_test)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(() => prisma.$disconnect());

  it('las migraciones coinciden con schema.prisma (sin drift)', () => {
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      { cwd: resolve(__dirname, '../..'), env: process.env, encoding: 'utf8', shell: true },
    );
    // --exit-code: 0 = sin diferencias, 2 = hay diferencias.
    expect(result.stdout + result.stderr).not.toMatch(/ALTER|CREATE|DROP/);
    expect(result.status).toBe(0);
  });

  it('las extensiones requeridas existen', async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension`;
    expect(rows.map((r) => r.extname)).toEqual(
      expect.arrayContaining(['postgis', 'btree_gist', 'pgcrypto', 'citext']),
    );
  });

  it('toda clave foránea está cubierta por un índice (CLAUDE.md §7.1)', async () => {
    const unindexed = await prisma.$queryRaw<{ constraint: string }[]>`
      SELECT c.conname AS constraint
      FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid
            AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
            AND c.conkey @> (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1]
        )`;
    expect(unindexed).toEqual([]);
  });

  it('todas las tablas tienen id UUID, created_at y updated_at timestamptz', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string; missing: string }[]>`
      SELECT t.table_name, req.col AS missing
      FROM information_schema.tables t
      CROSS JOIN (VALUES ('id', 'uuid'), ('created_at', 'timestamp with time zone'),
                         ('updated_at', 'timestamp with time zone')) AS req(col, type)
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND t.table_name NOT IN ('_prisma_migrations', 'spatial_ref_sys')
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.table_name = t.table_name
            AND c.column_name = req.col AND c.data_type = req.type
        )`;
    expect(rows).toEqual([]);
  });

  describe('seed de datos de prueba', () => {
    const password = randomBytes(18).toString('base64');
    const encryption = new EncryptionService(
      new StaticKeyProvider(validateEnv(process.env).crypto),
    );
    const run = () => seed({ prisma, encryption, password, jsonNull: Prisma.JsonNull });

    beforeAll(async () => {
      await truncateAll(prisma);
      await run();
    });

    it('es idempotente: ejecutarlo dos veces no duplica datos', async () => {
      const count = async () => ({
        users: await prisma.user.count(),
        roles: await prisma.userRole.count(),
        shops: await prisma.barbershop.count(),
        barbers: await prisma.barber.count(),
        services: await prisma.service.count(),
        hours: await prisma.businessHour.count(),
        schedules: await prisma.barberSchedule.count(),
        settings: await prisma.appSetting.count(),
      });
      const before = await count();
      await run();
      expect(await count()).toEqual(before);
      expect(before).toMatchObject({ users: 4, shops: 2, barbers: 3, services: 6 });
    });

    it('guarda datos personales cifrados y buscables por índice ciego', async () => {
      const { email } = SEED_USERS.client;
      const user = await prisma.user.findUniqueOrThrow({
        where: { emailHash: encryption.blindIndex(email.toUpperCase(), BlindIndexKind.EMAIL) },
      });
      expect(user.emailEnc).not.toContain('@');
      expect(encryption.decrypt(user.emailEnc, EncryptedField.USER_EMAIL)).toBe(email);
      expect(encryption.decrypt(user.phoneEnc!, EncryptedField.USER_PHONE)).toBe(
        SEED_USERS.client.phone,
      );
      await expect(PasswordHasher.verify(user.passwordHash, password)).resolves.toBe(true);
    });

    it('el responsable tiene roles OWNER y BARBER y administra dos sedes', async () => {
      const roles = await prisma.userRole.findMany({ where: { userId: SEED_USERS.owner.id } });
      expect(roles.map((r) => r.role).sort()).toEqual(['BARBER', 'OWNER']);
      expect(
        await prisma.barbershopMember.count({
          where: { userId: SEED_USERS.owner.id, role: 'OWNER' },
        }),
      ).toBe(2);
    });

    it('siembra app_settings con los valores definidos y las políticas pendientes en null', async () => {
      const settings = await prisma.appSetting.findMany();
      const byKey = Object.fromEntries(settings.map((s) => [s.key, s.value]));
      expect(byKey['availability.slot_interval_minutes']).toBe(15);
      expect(byKey['availability.min_lead_time_minutes']).toBe(0);
      expect(byKey['booking.pending_payment_ttl_minutes']).toBe(10);
      for (const pending of SEED_SETTINGS.filter((s) => s.value === null)) {
        expect(byKey[pending.key]).toBeNull();
      }
    });

    it('no sobrescribe un ajuste ya modificado', async () => {
      await prisma.appSetting.update({
        where: { key: 'availability.slot_interval_minutes' },
        data: { value: 30 },
      });
      await run();
      const setting = await prisma.appSetting.findUniqueOrThrow({
        where: { key: 'availability.slot_interval_minutes' },
      });
      expect(setting.value).toBe(30);
    });

    it('rechaza contraseñas cortas', async () => {
      await expect(
        seed({ prisma, encryption, password: 'corta', jsonNull: Prisma.JsonNull }),
      ).rejects.toThrow(/SEED_USER_PASSWORD/);
    });
  });
});
