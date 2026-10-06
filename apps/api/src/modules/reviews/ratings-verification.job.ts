import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { RatingsVerifier } from './review-ratings';

export const REVIEWS_QUEUE = 'reviews';
const VERIFY_RATINGS_JOB = 'verify-ratings';

@Processor(REVIEWS_QUEUE)
export class ReviewsProcessor extends WorkerHost {
  constructor(private readonly verifier: RatingsVerifier) {
    super();
  }

  async process(): Promise<void> {
    await this.verifier.verifyAll();
  }
}

/** Verificación de promedios cada noche, 03:30 de Lima (una sola aunque haya varias instancias). */
@Injectable()
export class ReviewsScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(REVIEWS_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    await this.queue.upsertJobScheduler(
      VERIFY_RATINGS_JOB,
      { pattern: '30 3 * * *', tz: 'America/Lima' },
      {
        name: VERIFY_RATINGS_JOB,
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 },
      },
    );
  }
}
