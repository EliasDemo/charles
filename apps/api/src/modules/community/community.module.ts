import { Module } from '@nestjs/common';
import { AdminAccessModule } from '../admin/admin-access.module';
import { ImageStorageModule } from '../images/image-storage.module';
import { ImagesModule } from '../images/images.module';
import { SettingsModule } from '../settings/settings.module';
import { CommunityModerationService } from './community-moderation.service';
import { CommunityPolicy } from './community-policy';
import {
  CommunityAdminController,
  CommunityController,
  ContentReportsController,
  SharePageController,
} from './community.controller';
import { CommunityService } from './community.service';

/** Comunidad: publicaciones, feed, comentarios, me gusta, seguidores, eventos y moderación. */
@Module({
  imports: [ImagesModule, ImageStorageModule, SettingsModule, AdminAccessModule],
  controllers: [
    CommunityController,
    ContentReportsController,
    SharePageController,
    CommunityAdminController,
  ],
  providers: [CommunityService, CommunityModerationService, CommunityPolicy],
  exports: [CommunityService, CommunityPolicy],
})
export class CommunityModule {}
