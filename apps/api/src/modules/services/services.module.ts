import { Module } from '@nestjs/common';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';

@Module({
  imports: [BarbershopAccessModule],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
