import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxDispatcher } from './outbox.dispatcher';
import type { OutboxMessage } from './outbox.service';

export const OUTBOX_MAX_ATTEMPTS = 8;
/** Un evento "en proceso" más tiempo que esto se da por perdido (relay caído) y se reentrega. */
const STALE_PROCESSING_SECONDS = 300;
const BATCH_SIZE = 50;

interface ClaimedRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
}

/** Espera antes del siguiente intento: 2^n segundos, con tope de 10 minutos. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(2 ** attempt, 600);
}

/**
 * Entrega los eventos del outbox a sus consumidores ("al menos una vez"). Reclama lotes con
 * `FOR UPDATE SKIP LOCKED`: varias instancias pueden correr a la vez sin entregar dos veces el
 * mismo lote. Los que fallan se reintentan con espera creciente y pasan a FAILED tras
 * `OUTBOX_MAX_ATTEMPTS`.
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  /** Procesa un lote. Devuelve cuántos eventos se entregaron con éxito. */
  async relayBatch(limit = BATCH_SIZE): Promise<number> {
    const claimed = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE outbox_events
         SET status = 'PROCESSING', attempts = attempts + 1, updated_at = now()
       WHERE id IN (
         SELECT id FROM outbox_events
          WHERE (status = 'PENDING' AND available_at <= now())
             OR (status = 'PROCESSING'
                 AND updated_at < now() - make_interval(secs => ${STALE_PROCESSING_SECONDS}))
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id, type, payload, attempts, created_at`;

    let delivered = 0;
    for (const row of claimed.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())) {
      const message: OutboxMessage = {
        id: row.id,
        type: row.type,
        payload: row.payload,
        attempt: row.attempts,
        createdAt: row.created_at,
      };
      try {
        await this.dispatcher.dispatch(message);
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: { status: 'PROCESSED', processedAt: new Date() },
        });
        delivered++;
      } catch (error) {
        const failed = row.attempts >= OUTBOX_MAX_ATTEMPTS;
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: {
            status: failed ? 'FAILED' : 'PENDING',
            availableAt: new Date(Date.now() + retryDelaySeconds(row.attempts) * 1000),
          },
        });
        // Sin el payload ni el mensaje completo: pueden contener datos que no deben ir a logs.
        this.logger.warn(
          `Evento ${row.id} (${row.type}) falló en el intento ${row.attempts}` +
            `${failed ? '; queda FAILED' : ''}: ${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    return delivered;
  }
}
