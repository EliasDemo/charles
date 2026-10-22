import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { seedDemoPlans } from './seed/plans';

/**
 * Planes y paquetes de auspiciadores de demostración (Fase 15). Idempotente: solo crea lo que no
 * existe. `pnpm --filter api seed:plans`.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Define DATABASE_URL.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const { plans, packages } = await seedDemoPlans(prisma);
    console.log(
      `Planes de demostración: ${plans} creados; paquetes de auspiciadores: ${packages} creados.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
