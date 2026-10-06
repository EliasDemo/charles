import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

/** Evento de dominio tal como lo recibe un consumidor. `id` es único: úsalo para idempotencia. */
export interface OutboxMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  /** Intento de entrega (1, 2, …). La entrega es "al menos una vez". */
  attempt: number;
  createdAt: Date;
}

/**
 * Publica eventos de dominio en `outbox_events` **dentro de la transacción del cambio** (CLAUDE.md
 * §8): si la transacción falla, el evento no existe; si se confirma, el relay lo entregará.
 * El payload lleva solo IDs y datos no personales.
 */
@Injectable()
export class OutboxService {
  async publish(
    tx: Prisma.TransactionClient,
    type: string,
    payload: Record<string, Prisma.InputJsonValue | null>,
  ): Promise<string> {
    const event = await tx.outboxEvent.create({
      data: { type, payload: payload },
      select: { id: true },
    });
    return event.id;
  }
}
