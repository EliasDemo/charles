import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { APP_CONFIG } from './common/config/app-config.token';
import type { AppConfig } from './common/config/env.validation';
import { validationExceptionFactory } from './common/errors/validation-exception.factory';
import { bodyParsers } from './common/http/body-parsers';
import { requestIdMiddleware } from './common/logging/logger.options';
import { setupSwagger } from './common/swagger/swagger';

const HSTS_MAX_AGE_SECONDS = 63_072_000; // 2 años, requisito para la lista de precarga

/**
 * Configuración HTTP común a `main.ts`, las pruebas e2e y la exportación de OpenAPI.
 * La app debe crearse con `{ bodyParser: false }` para aplicar el límite de tamaño.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);

  app.useLogger(app.get(Logger));

  // IP real del cliente detrás de proxies de confianza (afecta req.ip, req.secure y el límite de peticiones).
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Primero el ID de petición, para que incluso los errores del body-parser lo lleven.
  app.use(requestIdMiddleware);
  app.use(...bodyParsers(config.bodyLimit));

  app.use(
    helmet({
      hsts: { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true, preload: true },
    }),
  );

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );

  if (config.swaggerEnabled) setupSwagger(app);
}
