import { Module } from '@nestjs/common';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { BookingsModule } from '../bookings/bookings.module';
import { ServicesModule } from '../services/services.module';
import { UsersModule } from '../users/users.module';
import { BarbersController } from './barbers.controller';
import { BarbersService } from './barbers.service';

@Module({
  imports: [BarbershopAccessModule, ServicesModule, BookingsModule, UsersModule],
  controllers: [BarbersController],
  providers: [BarbersService],
  exports: [BarbersService],
})
export class BarbersModule {}
