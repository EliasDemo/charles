import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AdminAccessModule } from '../admin/admin-access.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { ReviewWriteRateLimitGuard } from '../reviews/review-rate-limit';
import { SettingsModule } from '../settings/settings.module';
import { BarbershopReportsService } from './barbershop-reports.service';
import {
  AdminTicketsController,
  BarbershopReportsController,
  SupportController,
} from './support.controller';
import { SUPPORT_QUEUE, SupportProcessor, SupportScheduler } from './support.job';
import { TicketsService } from './tickets.service';

/** Tickets de soporte y reportes de barberías (Fase 12, RF-SOP-001…003). */
@Module({
  imports: [
    AdminAccessModule,
    BarbershopAccessModule,
    SettingsModule,
    BullModule.registerQueue({ name: SUPPORT_QUEUE }),
  ],
  controllers: [SupportController, BarbershopReportsController, AdminTicketsController],
  providers: [
    TicketsService,
    BarbershopReportsService,
    ReviewWriteRateLimitGuard,
    SupportProcessor,
    SupportScheduler,
  ],
  exports: [TicketsService],
})
export class SupportModule {}
