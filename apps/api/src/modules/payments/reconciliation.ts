import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { PaymentsService } from './payments.service';

export const PAYMENTS_QUEUE = 'payments';
const DAILY_PENDING_AGE_MINUTES = 60;
const REFUND_RESEND_AGE_MINUTES = 10;
const BATCH = 100;

/** Resultado de revisar un pago o un reembolso contra la pasarela. */
export type ReconcileOutcome =
  | 'CONFIRMED' // corregido: confirmado en la pasarela y PENDING en Charles
  | 'REVIEW' // ambiguo: registrado para revisión, sin cambios
  | 'UNCHANGED' // sigue pendiente en la pasarela o ya estaba resuelto
  | 'UNAVAILABLE'; // la pasarela no respondió

/**
 * Conciliación con la pasarela (Fase 8A, ajustes A, B y C):
 * - Corrige solo los casos inequívocos (confirmado en la pasarela, PENDING en Charles) y siempre
 *   por `applyPaymentResult` / `applyRefundResult`, nunca escribiendo estados. Los ambiguos solo se
 *   registran. Todo queda en audit_log.
 * - Cada `payments.pending_check_interval_minutes` (2) revisa los pagos iniciados aún pendientes;
 *   una vez al día, todo lo pendiente antiguo (pagos y reembolsos).
 * - La consulta a la pasarela va siempre fuera de las transacciones (CLAUDE.md §1, regla 12).
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async checkPayment(paymentId: string): Promise<ReconcileOutcome> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== 'PENDING') return 'UNCHANGED';
    let state;
    try {
      state = await this.gateway.getPayment({
        paymentId,
        providerPaymentId: payment.providerPaymentId,
      });
    } catch {
      return 'UNAVAILABLE';
    }
    if (state.status === 'PENDING' || state.status === 'NOT_FOUND') return 'UNCHANGED';

    const matches =
      state.amount === payment.amount &&
      state.currency === payment.currency &&
      !(this.config.isProduction && state.mode === 'TEST');
    if (state.status === 'PAID' && matches) {
      await this.payments.handleResult(paymentId, 'SUCCEEDED', 'RECONCILIATION');
      await this.audit.record({
        action: 'payment.reconciled',
        entityType: 'payment',
        entityId: paymentId,
        changes: { values: { status: { from: 'PENDING', to: 'SUCCEEDED' } }, source: 'gateway' },
      });
      return 'CONFIRMED';
    }
    // UNPAID (podría reintentarse) o datos que no coinciden: no se toca, se registra.
    await this.audit.record({
      action: 'payment.reconciliation_review',
      entityType: 'payment',
      entityId: paymentId,
      changes: {
        providerStatus: state.status,
        amountMatches: state.amount === payment.amount,
        currencyMatches: state.currency === payment.currency,
        mode: state.mode,
      },
    });
    return 'REVIEW';
  }

  async checkRefund(refundId: string): Promise<ReconcileOutcome> {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund || refund.status !== 'PENDING') return 'UNCHANGED';
    if (!refund.requestedAt) {
      // Nunca llegó a la pasarela (fallaron los reintentos): se vuelve a enviar.
      try {
        await this.payments.executeRefund(refundId);
      } catch {
        return 'UNAVAILABLE';
      }
      return 'UNCHANGED';
    }
    let state;
    try {
      state = await this.gateway.getRefund({ refundId, providerRefundId: refund.providerRefundId });
    } catch {
      return 'UNAVAILABLE';
    }
    if (state.status === 'SUCCEEDED') {
      await this.payments.handleRefundResult(refundId, 'SUCCEEDED');
      await this.audit.record({
        action: 'refund.reconciled',
        entityType: 'refund',
        entityId: refundId,
        changes: { values: { status: { from: 'PENDING', to: 'SUCCEEDED' } }, source: 'gateway' },
      });
      return 'CONFIRMED';
    }
    if (state.status === 'FAILED') {
      await this.audit.record({
        action: 'refund.reconciliation_review',
        entityType: 'refund',
        entityId: refundId,
        changes: { providerStatus: state.status },
      });
      return 'REVIEW';
    }
    return 'UNCHANGED';
  }

  /** Cada pocos minutos: pagos ya iniciados en la pasarela que siguen PENDING. */
  async runQuick(): Promise<Record<ReconcileOutcome, number>> {
    const pending = await this.prisma.payment.findMany({
      where: { status: 'PENDING', startedAt: { not: null } },
      orderBy: { startedAt: 'asc' },
      take: BATCH,
      select: { id: true },
    });
    return this.tally(pending.map((p) => () => this.checkPayment(p.id)));
  }

  /** Una vez al día: todo pago o reembolso pendiente antiguo. */
  async runDaily(): Promise<Record<ReconcileOutcome, number>> {
    const now = this.clock.now();
    const [payments, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          status: 'PENDING',
          createdAt: { lte: new Date(now - DAILY_PENDING_AGE_MINUTES * 60_000) },
        },
        take: BATCH,
        select: { id: true },
      }),
      this.prisma.refund.findMany({
        where: {
          status: 'PENDING',
          createdAt: { lte: new Date(now - REFUND_RESEND_AGE_MINUTES * 60_000) },
        },
        take: BATCH,
        select: { id: true },
      }),
    ]);
    return this.tally([
      ...payments.map((p) => () => this.checkPayment(p.id)),
      ...refunds.map((r) => () => this.checkRefund(r.id)),
    ]);
  }

  private async tally(
    checks: (() => Promise<ReconcileOutcome>)[],
  ): Promise<Record<ReconcileOutcome, number>> {
    const totals: Record<ReconcileOutcome, number> = {
      CONFIRMED: 0,
      REVIEW: 0,
      UNCHANGED: 0,
      UNAVAILABLE: 0,
    };
    for (const check of checks) {
      try {
        totals[await check()]++;
      } catch (error) {
        totals.UNAVAILABLE++;
        this.logger.warn(`Conciliación: ${error instanceof Error ? error.name : 'error'}`);
      }
    }
    return totals;
  }
}

@Processor(PAYMENTS_QUEUE)
export class PaymentsProcessor extends WorkerHost {
  constructor(private readonly reconciliation: ReconciliationService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'reconcile-daily') await this.reconciliation.runDaily();
    else await this.reconciliation.runQuick();
  }
}

/** Programa la revisión rápida (cada N minutos) y la diaria (04:00 de Lima). */
@Injectable()
export class PaymentsScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly settings: SettingsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    const minutes = await this.settings.positiveInt(
      SettingKey.PAYMENTS_PENDING_CHECK_INTERVAL_MINUTES,
      2,
    );
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: 100 };
    await this.queue.upsertJobScheduler(
      'reconcile-quick',
      { every: minutes * 60_000 },
      { name: 'reconcile-quick', opts },
    );
    await this.queue.upsertJobScheduler(
      'reconcile-daily',
      { pattern: '0 4 * * *', tz: 'America/Lima' },
      { name: 'reconcile-daily', opts },
    );
  }
}
