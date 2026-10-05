import { Module } from '@nestjs/common';
import { BarbershopAccessService } from './barbershop-access.service';

/**
 * Verificación de membresía y visibilidad, separada para que `services`, `barbers` y
 * `barbershops` la usen sin dependencias circulares.
 */
@Module({
  providers: [BarbershopAccessService],
  exports: [BarbershopAccessService],
})
export class BarbershopAccessModule {}
