import { Module } from '@nestjs/common';
import { BarbersModule } from '../barbers/barbers.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { BookingsModule } from '../bookings/bookings.module';
import { ServicesModule } from '../services/services.module';
import { SettingsModule } from '../settings/settings.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { ScheduleRepository } from './schedule.repository';
import { ScheduleService } from './schedule.service';
import { ReadinessController, ReadinessService } from './readiness';

/** Horarios, bloqueos y motor de disponibilidad (Fase 5). Exporta el cálculo por lotes (Fase 6). */
@Module({
  imports: [BarbershopAccessModule, ServicesModule, BarbersModule, BookingsModule, SettingsModule],
  controllers: [AvailabilityController, ReadinessController],
  providers: [AvailabilityService, ScheduleService, ScheduleRepository, ReadinessService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
