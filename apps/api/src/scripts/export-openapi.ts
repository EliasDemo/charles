import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../app.module';
import { buildOpenApiDocument } from '../common/swagger/swagger';
import { configureApp } from '../configure-app';

/**
 * Genera `apps/api/openapi.json` sin levantar el servidor ni conectarse a la base de datos
 * (no se llama a `init()`, así que no se ejecutan los hooks de conexión).
 * Es la fuente del cliente tipado de `packages/shared`.
 */
async function exportOpenApi(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: false,
  });
  configureApp(app);
  const document = buildOpenApiDocument(app);
  const target = resolve(__dirname, '../../openapi.json');
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
}

void exportOpenApi();
