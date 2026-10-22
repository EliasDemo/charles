import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { BullModule } from '@nestjs/bullmq';
import { Inject, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { AdminAccessModule } from '../admin/admin-access.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { BalanceModule } from '../balance/balance';
import { PlanEnforcementService } from './plan-enforcement.service';
import {
  BarbershopPlanController,
  PlansAdminController,
  PlansController,
  SubscriptionsAdminController,
} from './plans.controller';
import { PlansService } from './plans.service';
import { SubscriptionsService } from './subscriptions.service';

export const BILLING_QUEUE = 'billing';
const MAINTENANCE_JOB = 'billing-maintenance';

@Processor(BILLING_QUEUE)
export class BillingProcessor extends WorkerHost {
  constructor(private readonly subscriptions: SubscriptionsService) {
    super();
  }

  async process(): Promise<void> {
    await this.subscriptions.runMaintenance();
  }
}

/** Mantenimiento de suscripciones cada hora (una sola ejecución aunque haya varias instancias). */
@Injectable()
export class BillingScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(BILLING_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOB,
      { pattern: '7 * * * *', tz: 'America/Lima' },
      { name: MAINTENANCE_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 } },
    );
  }
}

/** Fase 15: planes, suscripciones, límites por plan y su mantenimiento. */
@Module({
  imports: [
    BarbershopAccessModule,
    AdminAccessModule,
    SettingsModule,
    UsersModule,
    BalanceModule,
    BullModule.registerQueue({ name: BILLING_QUEUE }),
  ],
  controllers: [
    PlansController,
    BarbershopPlanController,
    PlansAdminController,
    SubscriptionsAdminController,
  ],
  providers: [
    PlansService,
    SubscriptionsService,
    PlanEnforcementService,
    BillingProcessor,
    BillingScheduler,
  ],
  exports: [SubscriptionsService, PlanEnforcementService],
})
export class PlansModule {}
