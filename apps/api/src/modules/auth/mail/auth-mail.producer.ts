import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AUTH_MAIL_QUEUE, type AuthMailJob } from './auth-mail.jobs';

/**
 * Encola los correos de autenticación. Encolar (en vez de enviar en la petición) hace que la
 * respuesta tarde lo mismo exista o no la cuenta, y que un fallo del proveedor se reintente.
 */
@Injectable()
export class AuthMailProducer {
  constructor(@InjectQueue(AUTH_MAIL_QUEUE) private readonly queue: Queue<AuthMailJob>) {}

  async enqueue(job: AuthMailJob): Promise<void> {
    await this.queue.add(job.type, job);
  }
}
