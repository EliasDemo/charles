import { ImageStorageModule } from '../images/image-storage.module';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { SettingsModule } from '../settings/settings.module';
import { FavoritesService } from './favorites.service';
import { REVIEWS_QUEUE, ReviewsProcessor, ReviewsScheduler } from './ratings-verification.job';
import { ReviewEligibilityService } from './review-eligibility.service';
import { ReviewModerationService } from './review-moderation.service';
import { ReviewRateLimitRefresher, ReviewWriteRateLimitGuard } from './review-rate-limit';
import { RatingsVerifier, ReviewRatings } from './review-ratings';
import { FavoritesController, ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

/** Favoritos y valoraciones (Fase 11). `ReviewModerationService` lo usa soporte (Fase 12). */
@Module({
  imports: [
    BarbershopAccessModule,
    SettingsModule,
    ImageStorageModule,
    BullModule.registerQueue({ name: REVIEWS_QUEUE }),
  ],
  controllers: [ReviewsController, FavoritesController],
  providers: [
    ReviewsService,
    FavoritesService,
    ReviewRatings,
    RatingsVerifier,
    ReviewModerationService,
    ReviewEligibilityService,
    ReviewWriteRateLimitGuard,
    ReviewRateLimitRefresher,
    ReviewsProcessor,
    ReviewsScheduler,
  ],
  exports: [ReviewModerationService, RatingsVerifier, FavoritesService, ReviewEligibilityService],
})
export class ReviewsModule {}
