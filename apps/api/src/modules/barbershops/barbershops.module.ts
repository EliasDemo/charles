import { ReviewsModule } from '../reviews/reviews.module';
import { Module } from '@nestjs/common';
import { BarbersModule } from '../barbers/barbers.module';
import { BookingsModule } from '../bookings/bookings.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { BarbershopAccessModule } from './barbershop-access.module';
import { BarbershopsController } from './barbershops.controller';
import { BarbershopsService } from './barbershops.service';
import { MembersService } from './members.service';

@Module({
  imports: [
    UsersModule,
    SettingsModule,
    BookingsModule,
    BarbershopAccessModule,
    BarbersModule,
    ReviewsModule,
  ],
  controllers: [BarbershopsController],
  providers: [BarbershopsService, MembersService],
  exports: [MembersService],
})
export class BarbershopsModule {}
