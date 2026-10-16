import { ReviewsModule } from '../reviews/reviews.module';
import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { ImageStorageModule } from '../images/image-storage.module';
import { ServicesModule } from '../services/services.module';
import { SettingsModule } from '../settings/settings.module';
import { FeaturedModule } from '../featured/featured.module';
import { FeaturedService } from '../featured/featured.service';
import { FeaturedRankingStrategy, RANKING_STRATEGY } from './ranking/ranking';
import { SearchCursor } from './search-cursor';
import { SearchRateLimitRefresher } from './search-rate-limit';
import { SearchController } from './search.controller';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';

/**
 * Búsqueda, cercanía, filtros y alternativas (Fase 6). El ranking es intercambiable vía
 * `RANKING_STRATEGY`: desde la Fase 13, orden orgánico con destacados (`featured_listings`).
 */
@Module({
  imports: [
    AvailabilityModule,
    BarbershopAccessModule,
    ServicesModule,
    SettingsModule,
    ReviewsModule,
    ImageStorageModule,
    FeaturedModule,
  ],
  controllers: [SearchController],
  providers: [
    SearchService,
    SearchRepository,
    SearchCursor,
    SearchRateLimitRefresher,
    {
      provide: RANKING_STRATEGY,
      inject: [FeaturedService],
      useFactory: (featured: FeaturedService) =>
        new FeaturedRankingStrategy((ids) => featured.activeAmong(ids)),
    },
  ],
})
export class SearchModule {}
