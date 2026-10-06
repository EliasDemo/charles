import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReconciliationService } from '../payments/reconciliation';
import { BookingStateMachine, SYSTEM_ACTOR } from './booking-state-machine';

export const BOOKINGS_QUEUE = 'bookings';
const EXPIRE_EVERY_MS = 60_000;
const BATCH_SIZE = 100;

/**
 * Vence las reservas PENDING_PAYMENT cuyo plazo pasó (→ EXPIRED, por la máquina de estados: con
 * historial y evento). Reclama lotes con `FOR UPDATE SKIP LOCKED`: varias instancias no chocan, y
 * una reserva que la creación de otra ya expiró simplemente no aparece. Idempotente.
 */
@Injectable()
export class BookingExpirationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: BookingStateMachine,
    private readonly reconciliation: ReconciliationService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Ajuste C (Fase 8A): antes de vencer una reserva cuyo pago ya se inició en la pasarela, se
   * consulta su estado (fuera de toda transacción). Si estaba pagada, se confirma en lugar de
   * vencer. Si la pasarela no responde, se vence igual: un pago confirmado después queda huérfano
   * y se devuelve completo.
   */
  async confirmPaidBeforeExpiring(): Promise<number> {
    const started = await this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        startedAt: { not: null },
        booking: { status: 'PENDING_PAYMENT', expiresAt: { lte: new Date(this.clock.now()) } },
      },
      take: BATCH_SIZE,
      select: { id: true },
    });
    let confirmed = 0;
    for (const payment of started) {
      if ((await this.reconciliation.checkPayment(payment.id)) === 'CONFIRMED') confirmed++;
    }
    return confirmed;
  }

  /** Devuelve cuántas reservas venció. */
  async expireDue(batchSize = BATCH_SIZE): Promise<number> {
    await this.confirmPaidBeforeExpiring();
    let total = 0;
    for (;;) {
      const expired = await this.prisma.$transaction(async (tx) => {
        const due = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM bookings
           WHERE status = 'PENDING_PAYMENT' AND expires_at <= ${new Date(this.clock.now())}
           ORDER BY expires_at
           LIMIT ${batchSize}
           FOR UPDATE SKIP LOCKED`;
        for (const { id } of due) {
          await this.stateMachine.transition(tx, id, 'EXPIRED', SYSTEM_ACTOR, 'payment_timeout');
        }
        return due.length;
      });
      total += expired;
      if (expired < batchSize) return total;
    }
  }
}

@Processor(BOOKINGS_QUEUE)
export class BookingsProcessor extends WorkerHost {
  constructor(private readonly expiration: BookingExpirationService) {
    super();
  }

  async process(): Promise<void> {
    await this.expiration.expireDue();
  }
}

/** Trabajo repetible cada minuto (uno solo aunque haya varias instancias de la API). */
@Injectable()
export class BookingsScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(BOOKINGS_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    await this.queue.upsertJobScheduler(
      'expire-pending-bookings',
      { every: EXPIRE_EVERY_MS },
      { name: 'expire', opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 } },
    );
  }
}
