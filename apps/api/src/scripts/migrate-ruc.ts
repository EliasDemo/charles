import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BlindIndexKind, EncryptedField } from '../common/crypto/encryption-contexts';
import { EncryptionService } from '../common/crypto/encryption.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { isValidRuc } from '../modules/barbershops/review-policy';

/**
 * Una sola vez, antes de eliminar la columna `barbershops.ruc` (en claro): copia cada RUC al
 * documento cifrado del responsable (tipo RUC) y vacía la columna. No pisa un documento ya
 * registrado. Un RUC con dígito verificador inválido se descarta y se informa (sin el número).
 * `pnpm --filter api migrate:ruc`
 */
void (async () => {
  process.env.SCHEDULED_JOBS_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const prisma = app.get(PrismaService);
    const encryption = app.get(EncryptionService);
    const rows = await prisma.$queryRaw<{ id: string; ruc: string; has_document: boolean }[]>`
      SELECT id::text AS id, ruc, owner_document_hash IS NOT NULL AS has_document
        FROM barbershops WHERE ruc IS NOT NULL`;
    let migrated = 0;
    let skipped = 0;
    for (const row of rows) {
      const ruc = row.ruc.replace(/\D/g, '');
      if (!row.has_document && isValidRuc(ruc)) {
        await prisma.barbershop.update({
          where: { id: row.id },
          data: {
            ownerDocumentType: 'RUC',
            ownerDocumentEnc: encryption.encrypt(ruc, EncryptedField.BARBERSHOP_OWNER_DOCUMENT),
            ownerDocumentHash: encryption.blindIndex(ruc, BlindIndexKind.DOCUMENT),
          },
        });
        migrated++;
      } else {
        skipped++;
        console.warn(`Barbería ${row.id}: RUC no migrado (inválido o ya tenía documento).`);
      }
      await prisma.$executeRaw`UPDATE barbershops SET ruc = NULL WHERE id = ${row.id}::uuid`;
    }
    console.warn(`RUC migrados: ${migrated}. Descartados: ${skipped}. Revisados: ${rows.length}.`);
  } finally {
    await app.close();
  }
})();
