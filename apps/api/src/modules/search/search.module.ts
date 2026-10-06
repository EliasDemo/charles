import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { ServicesModule } from '../services/services.module';
import { SettingsModule } from '../settings/settings.module';
import { OrganicRankingStrategy, RANKING_STRATEGY } from './ranking/ranking';
import { SearchCursor } from './search-cursor';
import { SearchRateLimitRefresher } from './search-rate-limit';
import { SearchController } from './search.controller';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';

/**
 * Búsqueda, cercanía, filtros y alternativas (Fase 6). El ranking es intercambiable vía
 * `RANKING_STRATEGY`: en la Fase 13 se reemplaza por una estrategia con destacados.
 */
@Module({
  imports: [AvailabilityModule, BarbershopAccessModule, ServicesModule, SettingsModule],
  controllers: [SearchController],
  providers: [
    SearchService,
    SearchRepository,
    SearchCursor,
    SearchRateLimitRefresher,
    { provide: RANKING_STRATEGY, useClass: OrganicRankingStrategy },
  ],
})
export class SearchModule {}
