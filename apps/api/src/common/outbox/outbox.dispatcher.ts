import { Injectable } from '@nestjs/common';
import type { OutboxMessage } from './outbox.service';

/**
 * Consumidor de eventos del outbox. La entrega es "al menos una vez": un mismo evento puede
 * llegar más de una vez (reintentos, caída del relay). Todo consumidor debe ser idempotente por
 * `message.id`; `IdempotentConsumerStore.runOnce` lo resuelve.
 */
export interface OutboxConsumer {
  /** Nombre estable: forma parte de la clave de idempotencia. */
  readonly name: string;
  /** Tipos de evento que atiende (por ejemplo `booking.confirmed`). */
  readonly types: readonly string[];
  handle(message: OutboxMessage): Promise<void>;
}

/** Registro de consumidores. Cada módulo registra los suyos al iniciar. */
@Injectable()
export class OutboxDispatcher {
  private readonly consumers: OutboxConsumer[] = [];

  register(consumer: OutboxConsumer): void {
    if (this.consumers.some((c) => c.name === consumer.name)) {
      throw new Error(`Consumidor de outbox duplicado: ${consumer.name}`);
    }
    this.consumers.push(consumer);
  }

  /** Entrega a todos los consumidores del tipo. Si uno falla, el evento se reintenta entero. */
  async dispatch(message: OutboxMessage): Promise<void> {
    for (const consumer of this.consumers) {
      if (consumer.types.includes(message.type)) await consumer.handle(message);
    }
  }
}
