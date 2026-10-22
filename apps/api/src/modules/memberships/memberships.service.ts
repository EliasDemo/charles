import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import {
  addMonths,
  BILLING_GATEWAY,
  type BillingGateway,
  BillingGatewayError,
  billingReference,
  DAY_MS,
} from '../billing/billing-gateway';
import {
  type AfterCommit,
  type BillingPaymentEvent,
  type BillingSubscriptionEvent,
  BillingWebhooksService,
} from '../billing/billing-webhooks.service';
import { MEMBERSHIP_CREDIT_METHOD, PaymentsService } from '../payments/payments.service';
import { EntitlementsService } from '../plans/entitlements.service';
import { BILLING_DEFAULTS } from '../plans/plans.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import type {
  CreateMembershipPlanDto,
  ManagedMembershipPlanDto,
  MembershipDto,
  MembershipPlanDto,
  ShopMemberDto,
  UpdateMembershipPlanDto,
} from './dto/membership.dto';
import { consumeCredit, creditBalance } from './membership-credits';

type Tx = Prisma.TransactionClient;
export const MEMBERSHIP_NOTICE_EVENT = 'billing.membership';
const PENDING_TTL_MS = 7 * DAY_MS;

const planInclude = {
  services: { select: { service: { select: { id: true, name: true } } } },
} satisfies Prisma.MembershipPlanInclude;
type PlanRow = Prisma.MembershipPlanGetPayload<{ include: typeof planInclude }>;
const membershipInclude = {
  membershipPlan: { include: planInclude },
  barbershop: { select: { name: true } },
  lots: { select: { remaining: true, expiresAt: true } },
} satisfies Prisma.MembershipInclude;
type MembershipRow = Prisma.MembershipGetPayload<{ include: typeof membershipInclude }>;

const notFound = (what = 'La membresía'): AppException =>
  new AppException(ErrorCode.NOT_FOUND, `${what} no existe.`, HttpStatus.NOT_FOUND);

const unavailable = (): AppException =>
  new AppException(
    ErrorCode.BILLING_UNAVAILABLE,
    'No pudimos conectar con la pasarela de pagos. Intenta en unos minutos.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );

/**
 * Membresías para clientes (Fase 16, ADR 0004).
 *
 * - La barbería las ofrece solo si su plan incluye "vender membresías". Si lo pierde, no vende
 *   nuevas, pero las vigentes se respetan.
 * - El cliente paga cada mes con la pasarela **dentro de la app** (son servicios presenciales: las
 *   tiendas lo permiten) y recibe créditos por cada periodo pagado.
 * - Los créditos no usados se acumulan **un mes como máximo**: cada lote vence al final del
 *   periodo siguiente.
 * - Cancelar: conserva los créditos hasta que vencen; no hay devolución del mes en curso.
 */
@Injectable()
export class MembershipsService implements OnModuleInit {
  private readonly logger = new Logger(MembershipsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly entitlements: EntitlementsService,
    private readonly payments: PaymentsService,
    private readonly webhooks: BillingWebhooksService,
    @Inject(BILLING_GATEWAY) private readonly gateway: BillingGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.webhooks.register('mem', {
      onSubscription: (tx, id, event) => this.onSubscription(tx, id, event),
      onPayment: (tx, id, event) => this.onPayment(tx, id, event),
    });
  }

  // ───────────── Membresías que ofrece la barbería ─────────────

  /** Público: las que se venden ahora (solo si el plan de la barbería lo incluye). */
  async publicPlans(barbershopId: string): Promise<MembershipPlanDto[]> {
    await this.access.requirePublic(barbershopId);
    if (!(await this.entitlements.has(barbershopId, 'memberships'))) return [];
    const rows = await this.prisma.membershipPlan.findMany({
      where: { barbershopId, isActive: true, deletedAt: null },
      include: planInclude,
      orderBy: { priceAmount: 'asc' },
    });
    return rows.map(toPlanDto);
  }

  async managedPlans(userId: string, barbershopId: string): Promise<ManagedMembershipPlanDto[]> {
    await this.access.requireMember(userId, barbershopId);
    const rows = await this.prisma.membershipPlan.findMany({
      where: { barbershopId, deletedAt: null },
      include: {
        ...planInclude,
        _count: {
          select: {
            memberships: { where: { status: { in: ['ACTIVE', 'PAST_DUE', 'CANCELED'] } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ ...toPlanDto(r), activeMembers: r._count.memberships }));
  }

  async createPlan(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    dto: CreateMembershipPlanDto,
  ): Promise<ManagedMembershipPlanDto> {
    await this.access.requireMember(actor.userId, barbershopId, ['OWNER']);
    await this.entitlements.assertFeature(barbershopId, 'memberships');
    await this.assertServices(barbershopId, dto.serviceIds ?? []);
    const plan = await this.prisma.$transaction(async (tx) => {
      const created = await tx.membershipPlan.create({
        data: {
          barbershopId,
          name: dto.name,
          description: dto.description || null,
          priceAmount: dto.priceAmount,
          currency: 'PEN',
          creditsPerPeriod: dto.creditsPerPeriod,
          services: { create: (dto.serviceIds ?? []).map((serviceId) => ({ serviceId })) },
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'membership_plan.created',
          entityType: 'membership_plan',
          entityId: created.id,
          changes: { barbershopId, priceAmount: dto.priceAmount, credits: dto.creditsPerPeriod },
          ip: actor.ip ?? null,
        },
        tx,
      );
      return created;
    });
    return (await this.managedPlans(actor.userId, barbershopId)).find((p) => p.id === plan.id)!;
  }

  async updatePlan(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    planId: string,
    dto: UpdateMembershipPlanDto,
  ): Promise<ManagedMembershipPlanDto> {
    await this.access.requireMember(actor.userId, barbershopId, ['OWNER']);
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, barbershopId, deletedAt: null },
    });
    if (!plan) throw notFound('La membresía');
    if (dto.isActive === true && !plan.isActive)
      await this.entitlements.assertFeature(barbershopId, 'memberships');
    if (dto.serviceIds) await this.assertServices(barbershopId, dto.serviceIds);
    await this.prisma.$transaction(async (tx) => {
      await tx.membershipPlan.update({
        where: { id: planId },
        data: {
          name: dto.name,
          description: dto.description === undefined ? undefined : dto.description || null,
          priceAmount: dto.priceAmount,
          creditsPerPeriod: dto.creditsPerPeriod,
          isActive: dto.isActive,
        },
      });
      if (dto.serviceIds) {
        await tx.membershipPlanService.deleteMany({ where: { membershipPlanId: planId } });
        if (dto.serviceIds.length > 0) {
          await tx.membershipPlanService.createMany({
            data: dto.serviceIds.map((serviceId) => ({ membershipPlanId: planId, serviceId })),
          });
        }
      }
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'membership_plan.updated',
          entityType: 'membership_plan',
          entityId: planId,
          changes: { ...dto },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    return (await this.managedPlans(actor.userId, barbershopId)).find((p) => p.id === planId)!;
  }

  async members(userId: string, barbershopId: string): Promise<ShopMemberDto[]> {
    await this.access.requireMember(userId, barbershopId);
    const rows = await this.prisma.membership.findMany({
      where: { barbershopId, status: { in: ['ACTIVE', 'PAST_DUE', 'CANCELED'] } },
      include: { ...membershipInclude, user: { select: { username: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const now = this.clock.now();
    return rows.map((r) => ({
      membershipId: r.id,
      username: r.user.username,
      planName: r.membershipPlan.name,
      status: r.status,
      credits: liveCredits(r, now),
      currentPeriodEnd: r.currentPeriodEnd,
    }));
  }

  // ───────────── Cliente ─────────────

  async mine(userId: string): Promise<MembershipDto[]> {
    const rows = await this.prisma.membership.findMany({
      where: { userId, status: { not: 'EXPIRED' } },
      include: membershipInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  /** El cliente se suscribe: devuelve el enlace de pago de la pasarela (se abre en la app). */
  async subscribe(userId: string, membershipPlanId: string): Promise<MembershipDto> {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: membershipPlanId, isActive: true, deletedAt: null },
      include: { barbershop: { select: { id: true, name: true } } },
    });
    if (!plan) throw notFound('La membresía');
    await this.access.requirePublic(plan.barbershopId);
    await this.entitlements.assertFeature(plan.barbershopId, 'memberships');
    const live = await this.prisma.membership.count({
      where: { userId, membershipPlanId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
    });
    if (live > 0) {
      throw new AppException(ErrorCode.CONFLICT, 'Ya tienes esta membresía.', HttpStatus.CONFLICT);
    }
    const email = await this.users.contactEmail(userId);
    if (!email) throw notFound('La cuenta');
    const membership = await this.prisma.$transaction(async (tx) => {
      await tx.membership.updateMany({
        where: { userId, membershipPlanId, status: 'PENDING' },
        data: { status: 'EXPIRED', endedAt: new Date(this.clock.now()) },
      });
      return tx.membership.create({
        data: {
          membershipPlanId,
          barbershopId: plan.barbershopId,
          userId,
          priceAmount: plan.priceAmount,
          currency: plan.currency,
          creditsPerPeriod: plan.creditsPerPeriod,
          provider: this.gateway.provider,
        },
        select: { id: true },
      });
    });
    let result;
    try {
      result = await this.gateway.createSubscription({
        reference: billingReference('mem', membership.id),
        reason: `${plan.name} — ${plan.barbershop.name}`,
        amount: plan.priceAmount,
        currency: plan.currency,
        frequencyMonths: 1,
        trialDays: 0,
        payerEmail: email,
        backUrl: `${this.config.payments.publicApiUrl ?? 'https://charles.invalid'}/api/v1/payments/done?status=pending`,
        idempotencyKey: membership.id,
      });
    } catch (error) {
      await this.prisma.membership.update({
        where: { id: membership.id },
        data: { status: 'EXPIRED', endedAt: new Date(this.clock.now()) },
      });
      if (error instanceof BillingGatewayError) throw unavailable();
      throw error;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.membership.update({
        where: { id: membership.id },
        data: {
          providerSubscriptionId: result.providerSubscriptionId,
          checkoutUrl: result.checkoutUrl,
        },
      });
      await this.notice(tx, membership.id, 'checkout_ready');
    });
    return this.one(userId, membership.id);
  }

  async cancel(userId: string, membershipId: string): Promise<MembershipDto> {
    const m = await this.prisma.membership.findFirst({ where: { id: membershipId, userId } });
    if (!m) throw notFound();
    if (!['PENDING', 'ACTIVE', 'PAST_DUE'].includes(m.status))
      return this.one(userId, membershipId);
    if (m.providerSubscriptionId) {
      try {
        await this.gateway.cancelSubscription(m.providerSubscriptionId);
      } catch (error) {
        if (error instanceof BillingGatewayError) throw unavailable();
        throw error;
      }
    }
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      await tx.membership.update({
        where: { id: membershipId },
        data:
          m.status === 'PENDING'
            ? { status: 'EXPIRED', endedAt: now, canceledAt: now }
            : { status: 'CANCELED', canceledAt: now, cancelAtPeriodEnd: true },
      });
      if (m.status !== 'PENDING') await this.notice(tx, membershipId, 'canceled');
    });
    return this.one(userId, membershipId);
  }

  async sync(userId: string, membershipId: string): Promise<MembershipDto> {
    const m = await this.prisma.membership.findFirst({ where: { id: membershipId, userId } });
    if (!m) throw notFound();
    if (m.providerSubscriptionId && ['PENDING', 'ACTIVE', 'PAST_DUE'].includes(m.status)) {
      let state;
      try {
        state = await this.gateway.getSubscription(m.providerSubscriptionId);
      } catch (error) {
        if (error instanceof BillingGatewayError) throw unavailable();
        throw error;
      }
      if (state.status !== 'NOT_FOUND' && state.status !== 'PENDING') {
        await this.webhooks.apply({
          kind: 'SUBSCRIPTION',
          providerEventId: `pre:${m.providerSubscriptionId}:${state.status}`,
          providerSubscriptionId: m.providerSubscriptionId,
          reference: billingReference('mem', m.id),
          status: state.status,
        });
      }
    }
    return this.one(userId, membershipId);
  }

  /**
   * Paga una reserva pendiente con un crédito: la reserva queda confirmada sin pasar por la
   * pasarela. Si después se cancela con derecho a devolución, el crédito vuelve.
   */
  async payBooking(
    userId: string,
    bookingId: string,
    membershipId: string,
  ): Promise<{ status: string }> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, clientId: userId },
      select: { id: true, status: true, expiresAt: true, barbershopId: true, serviceId: true },
    });
    if (!booking) throw notFound('La reserva');
    if (
      booking.status !== 'PENDING_PAYMENT' ||
      (booking.expiresAt && booking.expiresAt.getTime() <= this.clock.now())
    ) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'La reserva ya no está pendiente de pago.',
        HttpStatus.CONFLICT,
      );
    }
    const payment = await this.payments.pendingPaymentOf(bookingId);
    if (!payment) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'La reserva no tiene un pago pendiente.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payment.id}::uuid FOR UPDATE`;
      await consumeCredit(tx, {
        membershipId,
        barbershopId: booking.barbershopId,
        userId,
        serviceIds: [booking.serviceId],
        bookingId,
        now: this.clock.now(),
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          method: MEMBERSHIP_CREDIT_METHOD,
          metadata: { ...(payment.metadata as object), membershipId },
        },
      });
      await this.payments.applyPaymentResult(tx, payment.id, 'SUCCEEDED', 'WEBHOOK');
    });
    return { status: 'CONFIRMED' };
  }

  // ───────────── Avisos de la pasarela ─────────────

  private async onSubscription(
    tx: Tx,
    id: string,
    event: BillingSubscriptionEvent,
  ): Promise<AfterCommit | void> {
    const m = await tx.membership.findUnique({ where: { id } });
    if (!m) return;
    const now = new Date(this.clock.now());
    if (event.status === 'AUTHORIZED' && m.status === 'PENDING') {
      await tx.membership.update({
        where: { id },
        data: { status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: addMonths(now, 1) },
      });
      return;
    }
    if (event.status === 'CANCELLED') {
      if (m.status === 'PENDING') {
        await tx.membership.update({ where: { id }, data: { status: 'EXPIRED', endedAt: now } });
      } else if (m.status === 'ACTIVE' || m.status === 'PAST_DUE') {
        await tx.membership.update({
          where: { id },
          data: { status: 'CANCELED', canceledAt: now, cancelAtPeriodEnd: true },
        });
        await this.notice(tx, id, 'canceled');
      }
    }
  }

  private async onPayment(
    tx: Tx,
    id: string,
    event: BillingPaymentEvent,
  ): Promise<AfterCommit | void> {
    const m = await tx.membership.findUnique({ where: { id } });
    if (!m) return;
    const now = new Date(this.clock.now());
    const status =
      event.outcome === 'PAID' ? 'PAID' : event.outcome === 'FAILED' ? 'FAILED' : 'PENDING';
    const charge = await tx.billingCharge.upsert({
      where: {
        provider_providerPaymentId: {
          provider: this.gateway.provider,
          providerPaymentId: event.providerPaymentId,
        },
      },
      create: {
        purpose: 'MEMBERSHIP',
        membershipId: id,
        amount: event.amount,
        currency: event.currency,
        status,
        provider: this.gateway.provider,
        providerPaymentId: event.providerPaymentId,
        failureReason: event.failureReason,
        paidAt: status === 'PAID' ? now : null,
      },
      update: { status, failureReason: event.failureReason },
      select: { id: true, creditLot: { select: { id: true } } },
    });
    if (
      status === 'PAID' &&
      !charge.creditLot &&
      ['PENDING', 'ACTIVE', 'PAST_DUE'].includes(m.status)
    ) {
      const periodEnd = addMonths(now, 1);
      await tx.membership.update({
        where: { id },
        data: { status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: periodEnd },
      });
      // Acumulación de un mes como máximo: el lote vence al final del periodo siguiente.
      await tx.membershipCreditLot.create({
        data: {
          membershipId: id,
          chargeId: charge.id,
          granted: m.creditsPerPeriod,
          remaining: m.creditsPerPeriod,
          expiresAt: addMonths(periodEnd, 1),
        },
      });
      await this.notice(tx, id, 'credits_granted');
      return;
    }
    if (status === 'FAILED' && m.status === 'ACTIVE') {
      await tx.membership.update({ where: { id }, data: { status: 'PAST_DUE' } });
      await this.notice(tx, id, 'payment_failed');
    }
  }

  // ───────────── Mantenimiento ─────────────

  async runMaintenance(): Promise<number> {
    const now = new Date(this.clock.now());
    const graceDays = await this.settings.positiveInt(
      SettingKey.BILLING_GRACE_DAYS,
      BILLING_DEFAULTS.graceDays,
    );
    let ended = 0;
    const due = await this.prisma.membership.findMany({
      where: {
        OR: [
          {
            status: 'CANCELED',
            OR: [{ currentPeriodEnd: { lt: now } }, { currentPeriodEnd: null }],
          },
          { status: 'PAST_DUE', updatedAt: { lt: new Date(now.getTime() - graceDays * DAY_MS) } },
        ],
      },
      select: { id: true, status: true, providerSubscriptionId: true },
      take: 200,
    });
    for (const m of due) {
      if (m.status === 'PAST_DUE' && m.providerSubscriptionId) {
        try {
          await this.gateway.cancelSubscription(m.providerSubscriptionId);
        } catch (error) {
          this.logger.warn(`No se pudo cancelar la membresía ${m.id}: ${(error as Error).message}`);
          continue;
        }
      }
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.membership.updateMany({
          where: { id: m.id, status: m.status },
          data: { status: 'EXPIRED', endedAt: now },
        });
        if (count > 0) await this.notice(tx, m.id, 'expired');
      });
      ended++;
    }
    const abandoned = await this.prisma.membership.updateMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - PENDING_TTL_MS) } },
      data: { status: 'EXPIRED', endedAt: now },
    });
    return ended + abandoned.count;
  }

  // ───────────── Apoyo ─────────────

  private async one(userId: string, id: string): Promise<MembershipDto> {
    const row = await this.prisma.membership.findFirst({
      where: { id, userId },
      include: membershipInclude,
    });
    if (!row) throw notFound();
    return this.toDto(row);
  }

  async balance(membershipId: string): Promise<number> {
    return creditBalance(this.prisma, membershipId, this.clock.now());
  }

  private toDto(r: MembershipRow): MembershipDto {
    const now = this.clock.now();
    const live = r.lots.filter((l) => l.expiresAt.getTime() > now && l.remaining > 0);
    const next = live.map((l) => l.expiresAt.getTime()).sort((a, b) => a - b)[0];
    return {
      id: r.id,
      plan: toPlanDto(r.membershipPlan),
      barbershopName: r.barbershop.name,
      status: r.status,
      priceAmount: r.priceAmount,
      currency: r.currency,
      credits: liveCredits(r, now),
      nextCreditsExpireAt: next ? new Date(next) : null,
      checkoutUrl: r.status === 'PENDING' ? r.checkoutUrl : null,
      currentPeriodEnd: r.currentPeriodEnd,
      cancelAtPeriodEnd: r.cancelAtPeriodEnd,
      createdAt: r.createdAt,
    };
  }

  private async assertServices(barbershopId: string, serviceIds: string[]): Promise<void> {
    if (serviceIds.length === 0) return;
    const owned = await this.prisma.service.count({
      where: { id: { in: serviceIds }, barbershopId, deletedAt: null },
    });
    if (owned !== serviceIds.length) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'serviceIds', constraints: ['serviceOfBarbershop'] }],
      );
    }
  }

  private async notice(tx: Tx, membershipId: string, notice: string): Promise<void> {
    await this.outbox.publish(tx, MEMBERSHIP_NOTICE_EVENT, { membershipId, notice });
  }
}

function liveCredits(r: { lots: { remaining: number; expiresAt: Date }[] }, now: number): number {
  return r.lots.filter((l) => l.expiresAt.getTime() > now).reduce((sum, l) => sum + l.remaining, 0);
}

function toPlanDto(p: PlanRow): MembershipPlanDto {
  return {
    id: p.id,
    barbershopId: p.barbershopId,
    name: p.name,
    description: p.description,
    priceAmount: p.priceAmount,
    currency: p.currency,
    creditsPerPeriod: p.creditsPerPeriod,
    services: p.services.map((s) => ({ id: s.service.id, name: s.service.name })),
    isActive: p.isActive,
  };
}
