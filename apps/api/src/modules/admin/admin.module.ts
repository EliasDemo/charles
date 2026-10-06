import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BookingsManagementModule } from '../bookings/bookings-management.module';
import { BookingsModule } from '../bookings/bookings.module';
import { ModerationModule } from '../moderation/moderation.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { ServicesModule } from '../services/services.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminAccessModule } from './admin-access.module';
import { AdminBarbershopsService } from './admin-barbershops.service';
import { AdminOperationsService } from './admin-operations.service';
import { AdminSettingsService } from './admin-settings';
import { AdminUsersService } from './admin-users.service';
import {
  AdminBarbershopsController,
  AdminConfigController,
  AdminOperationsController,
  AdminUsersController,
} from './admin.controller';

/** Operación de la plataforma (Fase 12, RF-OPE-001…003): `/api/v1/admin`. */
@Module({
  imports: [
    AdminAccessModule,
    AuthModule,
    BookingsModule,
    BookingsManagementModule,
    PaymentsModule,
    ModerationModule,
    ReviewsModule,
    ServicesModule,
    SettingsModule,
  ],
  controllers: [
    AdminUsersController,
    AdminBarbershopsController,
    AdminOperationsController,
    AdminConfigController,
  ],
  providers: [
    AdminUsersService,
    AdminBarbershopsService,
    AdminOperationsService,
    AdminSettingsService,
  ],
})
export class AdminModule {}
