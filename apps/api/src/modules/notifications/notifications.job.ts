import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { NotificationsService } from './notifications.service';

export const NOTIFICATIONS_QUEUE = 'notifications';

const JOBS = {
  deliver: { every: 15_000 },
  reminders: { every: 5 * 60_000 },
  receipts: { every: 15 * 60_000 },
  purge: { every: 24 * 3_600_000 },
} as const;
type JobName = keyof typeof JOBS;

@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost {
  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name as JobName) {
      case 'deliver':
        // Vacía la cola pendiente por lotes.
        while ((await this.notifications.deliverDue()) > 0);
        break;
      case 'reminders':
        await this.notifications.scanReminders();
        break;
      case 'receipts':
        await this.notifications.checkReceipts();
        break;
      case 'purge':
        await this.notifications.purgeOld();
        break;
    }
  }
}

/** Entrega cada 15 s, recordatorios cada 5 min, recibos de Expo cada 15 min, limpieza diaria. */
@Injectable()
export class NotificationsScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    for (const [name, repeat] of Object.entries(JOBS)) {
      await this.queue.upsertJobScheduler(`notifications-${name}`, repeat, {
        name,
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 },
      });
    }
  }
}
