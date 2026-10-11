import { Module } from '@nestjs/common';
import { AdminAccessModule } from '../admin/admin-access.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { SettingsModule } from '../settings/settings.module';
import { ImageModerationService } from './image-moderation.service';
import { ImageRateLimitRefresher, ImageUploadRateLimitGuard } from './image-rate-limit';
import { ImageStorageModule } from './image-storage.module';
import { ImagesAdminController } from './images-admin.controller';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';
import { MediaController } from './media.controller';

/** Imágenes, galería, estilos y moderación de fotos (Fase 14). */
@Module({
  imports: [ImageStorageModule, BarbershopAccessModule, SettingsModule, AdminAccessModule],
  controllers: [ImagesController, ImagesAdminController, MediaController],
  providers: [
    ImagesService,
    ImageModerationService,
    ImageUploadRateLimitGuard,
    ImageRateLimitRefresher,
  ],
  exports: [ImagesService],
})
export class ImagesModule {}
