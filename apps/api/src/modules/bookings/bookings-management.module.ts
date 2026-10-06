import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { BarbersModule } from '../barbers/barbers.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { PaymentsModule } from '../payments/payments.module';
import { ServicesModule } from '../services/services.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import {
  BOOKINGS_QUEUE,
  BookingExpirationService,
  BookingsProcessor,
  BookingsScheduler,
} from './booking-expiration';
import { BookingCreationRateLimitGuard, BookingRateLimitRefresher } from './booking-rate-limit';
import { BookingsController } from './bookings.controller';
import { BookingsModule } from './bookings.module';
import { BookingsService } from './bookings.service';

/** Reservas (Fase 7): crear, cancelar, consultar y vencer las que no se pagan. */
@Module({
  imports: [
    BookingsModule,
    PaymentsModule,
    AvailabilityModule,
    ServicesModule,
    BarbersModule,
    BarbershopAccessModule,
    UsersModule,
    SettingsModule,
    BullModule.registerQueue({ name: BOOKINGS_QUEUE }),
  ],
  controllers: [BookingsController],
  providers: [
    BookingsService,
    BookingExpirationService,
    BookingsProcessor,
    BookingsScheduler,
    BookingCreationRateLimitGuard,
    BookingRateLimitRefresher,
  ],
  exports: [BookingExpirationService],
})
export class BookingsManagementModule {}
