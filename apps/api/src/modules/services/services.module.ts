import { Module } from '@nestjs/common';
import { BarbershopsModule } from '../barbershops/barbershops.module';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';

@Module({
  imports: [BarbershopsModule],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
