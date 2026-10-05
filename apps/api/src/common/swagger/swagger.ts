import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto } from '../errors/error-response.dto';

export const SWAGGER_PATH = 'api/docs';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Charles API')
    .setDescription('API de reservas para barberías. Todos los endpoints están bajo /api/v1.')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config, { extraModels: [ErrorResponseDto] });
}

/** Swagger solo se monta si SWAGGER_ENABLED=true (prohibido en producción, ver env.validation). */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(SWAGGER_PATH, app, () => buildOpenApiDocument(app));
}
