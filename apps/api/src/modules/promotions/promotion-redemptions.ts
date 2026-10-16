import { Injectable, Module } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

/**
 * Canjes de promociones vistos desde la reserva (Fase 13). Sin dependencias: la máquina de estados
 * de la reserva lo usa para **liberar el cupo** cuando una reserva se cancela o vence, en la misma
 * transacción del cambio de estado.
 */
@Injectable()
export class PromotionRedemptions {
  /** Libera el canje de la reserva (idempotente). El cupo vuelve a estar disponible. */
  async releaseForBooking(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
    await tx.promotionRedemption.updateMany({
      where: { bookingId, releasedAt: null },
      data: { releasedAt: new Date() },
    });
  }
}

@Module({ providers: [PromotionRedemptions], exports: [PromotionRedemptions] })
export class PromotionRedemptionsModule {}
