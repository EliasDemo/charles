import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { validateEnv } from '../src/common/config/env.validation';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { StaticKeyProvider } from '../src/common/crypto/key-provider';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { seed } from './seed/seed';

/** `pnpm --filter api prisma db seed`. Nunca se ejecuta en producción. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('El seed de datos de prueba no se ejecuta en producción.');
  }
  const password = process.env.SEED_USER_PASSWORD;
  if (!password) {
    throw new Error(
      'Define SEED_USER_PASSWORD (no se versiona) para crear los usuarios de prueba.',
    );
  }

  const config = validateEnv(process.env);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: config.databaseUrl }),
  });
  try {
    await seed({
      prisma,
      encryption: new EncryptionService(new StaticKeyProvider(config.crypto)),
      password,
      jsonNull: Prisma.JsonNull,
    });
    console.log('Seed completado: datos de prueba ficticios cargados.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
