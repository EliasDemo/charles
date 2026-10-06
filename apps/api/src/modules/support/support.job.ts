import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { TicketsService } from './tickets.service';

export const SUPPORT_QUEUE = 'support';
const AUTO_CLOSE_TICKETS_JOB = 'auto-close-resolved-tickets';
const EVERY_MS = 3_600_000;

@Processor(SUPPORT_QUEUE)
export class SupportProcessor extends WorkerHost {
  constructor(private readonly tickets: TicketsService) {
    super();
  }

  async process(): Promise<void> {
    await this.tickets.autoCloseResolved();
  }
}

/** Cierre automático de tickets resueltos, cada hora (uno solo aunque haya varias instancias). */
@Injectable()
export class SupportScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(SUPPORT_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    await this.queue.upsertJobScheduler(
      AUTO_CLOSE_TICKETS_JOB,
      { every: EVERY_MS },
      {
        name: AUTO_CLOSE_TICKETS_JOB,
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 },
      },
    );
  }
}
