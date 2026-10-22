import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';
import { seedServiceCategories, seedServiceStyles } from './seed/categories';
import { seedFaceShapeReference } from './seed/face-shape';
import { seedPeruDistricts } from './seed/peru-districts';
import { SEED_SETTINGS } from './seed/seed';

/**
 * Datos de referencia (categorías y estilos de servicio y, con --settings, claves de app_settings que
 * falten). Idempotente: solo crea lo que no existe, nunca modifica ni borra. Apto para cualquier
 * entorno: `pnpm --filter api seed:reference [--settings]`.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Define DATABASE_URL.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const categories = await seedServiceCategories(prisma);
    const styles = await seedServiceStyles(prisma);
    const faceShape = await seedFaceShapeReference(prisma);
    const districts = await seedPeruDistricts(prisma);
    let settings = 0;
    if (process.argv.includes('--settings')) {
      for (const setting of SEED_SETTINGS) {
        const exists = await prisma.appSetting.findUnique({ where: { key: setting.key } });
        if (exists) continue;
        await prisma.appSetting.create({
          data: {
            key: setting.key,
            value: setting.value === null ? Prisma.JsonNull : setting.value,
            description: setting.description,
          },
        });
        console.log(`Ajuste creado: ${setting.key}`);
        settings++;
      }
    }
    console.log(
      `Datos de referencia: ${categories} categorías, ${styles} estilos, ${faceShape.rules} reglas de ` +
        `forma de cara (${faceShape.styles} cortes completados) y ${settings} ajustes creados; ${districts} distritos del Perú.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
