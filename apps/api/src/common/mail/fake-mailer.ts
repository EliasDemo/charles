import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { Mailer, MailMessage } from './mailer';

export const FAKE_MAILER_INBOX_KEY = 'fake-mailer:inbox';
const INBOX_MAX_MESSAGES = 200;
const INBOX_TTL_SECONDS = 3600;

export interface StoredMail extends MailMessage {
  sentAt: string;
}

/**
 * Correo simulado (prohibido en producción). Guarda los mensajes en Redis para consultarlos
 * en desarrollo y en pruebas. Nunca escribe el destinatario ni el contenido en los logs.
 */
@Injectable()
export class FakeMailer implements Mailer {
  private readonly logger = new Logger(FakeMailer.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async send(message: MailMessage): Promise<void> {
    const stored: StoredMail = { ...message, sentAt: new Date().toISOString() };
    await this.redis
      .multi()
      .lpush(FAKE_MAILER_INBOX_KEY, JSON.stringify(stored))
      .ltrim(FAKE_MAILER_INBOX_KEY, 0, INBOX_MAX_MESSAGES - 1)
      .expire(FAKE_MAILER_INBOX_KEY, INBOX_TTL_SECONDS)
      .exec();
    this.logger.log({ category: message.category }, 'Correo simulado guardado en Redis');
  }

  /** Mensajes más recientes primero (para desarrollo y pruebas). */
  async inbox(): Promise<StoredMail[]> {
    const raw = await this.redis.lrange(FAKE_MAILER_INBOX_KEY, 0, -1);
    return raw.map((item) => JSON.parse(item) as StoredMail);
  }
}
