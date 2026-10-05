import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // `prisma generate` (postinstall) no necesita conexión: en un clon sin .env no debe fallar.
    // Los comandos que sí conectan (migrate, db seed) fallan si DATABASE_URL no está definida.
    url: process.env.DATABASE_URL ?? '',
  },
});
