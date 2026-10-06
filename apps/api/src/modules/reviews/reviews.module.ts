import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { SettingsModule } from '../settings/settings.module';
import { FavoritesService } from './favorites.service';
import { REVIEWS_QUEUE, ReviewsProcessor, ReviewsScheduler } from './ratings-verification.job';
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
    BullModule.registerQueue({ name: REVIEWS_QUEUE }),
  ],
  controllers: [ReviewsController, FavoritesController],
  providers: [
    ReviewsService,
    FavoritesService,
    ReviewRatings,
    RatingsVerifier,
    ReviewModerationService,
    ReviewWriteRateLimitGuard,
    ReviewRateLimitRefresher,
    ReviewsProcessor,
    ReviewsScheduler,
  ],
  exports: [ReviewModerationService, RatingsVerifier],
})
export class ReviewsModule {}
