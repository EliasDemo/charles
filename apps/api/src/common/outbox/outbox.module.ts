import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Global, Inject, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/env.validation';
import { IdempotentConsumerStore } from './idempotent-consumer';
import { OutboxDispatcher } from './outbox.dispatcher';
import { OutboxRelay } from './outbox.relay';
import { OutboxService } from './outbox.service';

export const OUTBOX_QUEUE = 'outbox';
const RELAY_EVERY_MS = 5_000;

@Processor(OUTBOX_QUEUE)
export class OutboxRelayProcessor extends WorkerHost {
  constructor(private readonly relay: OutboxRelay) {
    super();
  }

  async process(): Promise<void> {
    await this.relay.relayBatch();
  }
}

/** Programa el relay cada 5 s (trabajo repetible de BullMQ: uno solo aunque haya varias instancias). */
@Injectable()
export class OutboxScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(OUTBOX_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    await this.queue.upsertJobScheduler(
      'outbox-relay',
      { every: RELAY_EVERY_MS },
      { name: 'relay', opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 } },
    );
  }
}

/** Outbox transaccional de eventos de dominio (CLAUDE.md §8). */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: OUTBOX_QUEUE })],
  providers: [
    OutboxService,
    OutboxDispatcher,
    OutboxRelay,
    IdempotentConsumerStore,
    OutboxRelayProcessor,
    OutboxScheduler,
  ],
  exports: [OutboxService, OutboxDispatcher, OutboxRelay, IdempotentConsumerStore],
})
export class OutboxModule {}
