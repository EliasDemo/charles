import { Module } from '@nestjs/common';
import { AdminAccessModule } from '../admin/admin-access.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { PromotionsAdminController, PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';

/** Fase 13: promociones y cupones (descuento en la reserva y su administración). */
@Module({
  imports: [BarbershopAccessModule, AdminAccessModule],
  controllers: [PromotionsController, PromotionsAdminController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
