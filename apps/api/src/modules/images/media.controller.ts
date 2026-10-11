import { Controller, Get, HttpStatus, Inject, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { IMAGE_STORAGE, type ImageStorage, MEDIA_ROUTE } from './image-storage';

/** Solo las claves que genera la API: `img/<22 caracteres base64url>/<variante>.webp`. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const VARIANTS = new Set(['thumb.webp', 'large.webp', 'square.webp']);

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'No encontrado.', HttpStatus.NOT_FOUND);

/**
 * Sirve las imágenes **solo en desarrollo y pruebas**, cuando no hay `MEDIA_PUBLIC_BASE_URL`. En
 * producción las sirve el almacenamiento (R2) o un CDN directamente, y esta ruta responde 404.
 */
@ApiExcludeController()
@Controller(MEDIA_ROUTE)
export class MediaController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
  ) {}

  @Public()
  @Get('img/:prefix/:file')
  async serve(
    @Param('prefix') prefix: string,
    @Param('file') file: string,
    @Res() res: Response,
  ): Promise<void> {
    if (this.config.isProduction || this.config.storage.publicBaseUrl || !this.storage.enabled) {
      throw notFound();
    }
    if (!KEY_PATTERN.test(prefix) || !VARIANTS.has(file)) throw notFound();
    const object = await this.storage.get(`img/${prefix}/${file}`);
    if (!object) throw notFound();
    res
      .status(HttpStatus.OK)
      .setHeader('Content-Type', 'image/webp')
      .setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(object.body);
  }
}
