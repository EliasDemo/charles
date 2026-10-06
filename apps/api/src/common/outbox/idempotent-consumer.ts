import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

const KEY_PREFIX = 'outbox:consumed';
/** Más que cualquier ventana de reintento del relay. */
const TTL_SECONDS = 30 * 24 * 3600;

/**
 * Idempotencia de consumidores del outbox (entrega "al menos una vez"): marca cada
 * (consumidor, evento) como procesado. Si el efecto falla, se libera la marca para que el
 * reintento lo vuelva a ejecutar.
 *
 * La marca vive en Redis con 30 días de vida. Un consumidor cuyo efecto deba ser idempotente
 * para siempre (por ejemplo, un cobro) debe además apoyarse en una restricción única en la base.
 */
@Injectable()
export class IdempotentConsumerStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Ejecuta `effect` solo la primera vez para este consumidor y evento. Devuelve si se ejecutó. */
  async runOnce(consumer: string, eventId: string, effect: () => Promise<void>): Promise<boolean> {
    const key = `${KEY_PREFIX}:${consumer}:${eventId}`;
    const claimed = await this.redis.set(key, '1', 'EX', TTL_SECONDS, 'NX');
    if (claimed !== 'OK') return false;
    try {
      await effect();
      return true;
    } catch (error) {
      await this.redis.del(key);
      throw error;
    }
  }

  async wasProcessed(consumer: string, eventId: string): Promise<boolean> {
    return (await this.redis.exists(`${KEY_PREFIX}:${consumer}:${eventId}`)) === 1;
  }
}
