import { Module } from '@nestjs/common';
import { BarbershopsModule } from '../barbershops/barbershops.module';
import { BookingsModule } from '../bookings/bookings.module';
import { ServicesModule } from '../services/services.module';
import { UsersModule } from '../users/users.module';
import { BarbersController } from './barbers.controller';
import { BarbersService } from './barbers.service';

@Module({
  imports: [BarbershopsModule, ServicesModule, BookingsModule, UsersModule],
  controllers: [BarbersController],
  providers: [BarbersService],
  exports: [BarbersService],
})
export class BarbersModule {}
