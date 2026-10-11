import { Module } from '@nestjs/common';
import { IMAGE_STORAGE, S3ImageStorage } from './image-storage';

/** Proveedor del almacenamiento de imágenes, compartido por los módulos que muestran fotos. */
@Module({
  providers: [{ provide: IMAGE_STORAGE, useClass: S3ImageStorage }],
  exports: [IMAGE_STORAGE],
})
export class ImageStorageModule {}
