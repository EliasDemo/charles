import { Global, Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';

/** Derechos por plan (Fase 15): global, para que cualquier módulo los consulte sin ciclos. */
@Global()
@Module({
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
