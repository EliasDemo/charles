import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { BarbershopAccessService } from './barbershop-access.service';
import { BarbershopsController } from './barbershops.controller';
import { BarbershopsService } from './barbershops.service';
import { MembersService } from './members.service';

@Module({
  imports: [UsersModule, SettingsModule, BookingsModule],
  controllers: [BarbershopsController],
  providers: [BarbershopsService, BarbershopAccessService, MembersService],
  exports: [BarbershopAccessService, MembersService],
})
export class BarbershopsModule {}
