import { ImagesModule } from '../images/images.module';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { AuthModule } from '../auth/auth.module';
import { BookingsManagementModule } from '../bookings/bookings-management.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { AccountController } from './account.controller';
import { AccountDeletionService } from './account-deletion.service';

export const ACCOUNT_QUEUE = 'account';

@Processor(ACCOUNT_QUEUE)
export class AccountProcessor extends WorkerHost {
  constructor(private readonly deletion: AccountDeletionService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'deletion-reminders') await this.deletion.sendReminders();
    if (job.name === 'deletion-execute') {
      while ((await this.deletion.executeDue()) > 0);
    }
  }
}

/** Recordatorios y ejecución de eliminaciones vencidas, cada hora. */
@Injectable()
export class AccountScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(ACCOUNT_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    for (const name of ['deletion-reminders', 'deletion-execute']) {
      await this.queue.upsertJobScheduler(
        `account-${name}`,
        { every: 3_600_000 },
        {
          name,
          opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 },
        },
      );
    }
  }
}

/** Cuenta propia: eliminación (Apple y Google). */
@Module({
  imports: [
    AuthModule,
    UsersModule,
    SettingsModule,
    BookingsManagementModule,
    ImagesModule,
    BullModule.registerQueue({ name: ACCOUNT_QUEUE }),
  ],
  controllers: [AccountController],
  providers: [AccountDeletionService, AccountProcessor, AccountScheduler],
  exports: [AccountDeletionService],
})
export class AccountModule {}
