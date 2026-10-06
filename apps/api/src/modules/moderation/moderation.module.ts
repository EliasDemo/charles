import { Module } from '@nestjs/common';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { CancellationReviewsService } from './cancellation-reviews.service';

/** Moderación (Fase 8A: cancelaciones de la barbería y su sanción; soporte en la Fase 12). */
@Module({
  imports: [BarbershopAccessModule, UsersModule, SettingsModule],
  providers: [CancellationReviewsService],
  exports: [CancellationReviewsService],
})
export class ModerationModule {}
