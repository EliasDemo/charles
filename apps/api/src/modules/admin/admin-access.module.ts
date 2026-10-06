import { Module } from '@nestjs/common';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { UsersModule } from '../users/users.module';
import { AdminAccessGuard, ConflictOfInterestService } from './admin-access';

/** Autorización de `/admin` y regla de conflicto de interés (Fase 12). */
@Module({
  imports: [UsersModule, BarbershopAccessModule],
  providers: [AdminAccessGuard, ConflictOfInterestService],
  exports: [AdminAccessGuard, ConflictOfInterestService, UsersModule],
})
export class AdminAccessModule {}
