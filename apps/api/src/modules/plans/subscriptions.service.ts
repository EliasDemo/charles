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
import { BalanceService, insufficient } from '../balance/balance';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import type {
  AdminSubscriptionDto,
  BarbershopPlanDto,
  BillingSummaryDto,
  FeaturedFromPlanDto,
  PlanUsageDto,
  PublicPlanBadgesDto,
  SubscribeDto,
  SubscriptionDto,
} from './dto/plan.dto';
import { ENTITLEMENT_CATALOG, type EntitlementKey, limitOf } from './entitlements';
import { audienceOf, EntitlementsService } from './entitlements.service';
import { PlanEnforcementService } from './plan-enforcement.service';
import {
  subscriptionInclude,
  type SubscriptionRow,
  toPlanDto,
  toSubscriptionDto,
} from './plan-mapping';
import { BILLING_DEFAULTS, LIVE_STATUSES, SUBSCRIPTION_NOTICE_EVENT } from './plans.service';

type Tx = Prisma.TransactionClient;
/** Un enlace de pago sin usar vence a los 7 días. */
const PENDING_TTL_MS = 7 * DAY_MS;
const BACK_PATH = '/api/v1/payments/done?status=pending';
/** Proveedor de las suscripciones pagadas con el saldo a favor (sin pasarela). */
export const BALANCE_PROVIDER = 'BALANCE';

export type SubscriptionNotice =
  | 'checkout_ready'
  | 'activated'
  | 'trial_ending'
  | 'payment_failed'
  | 'recovered'
  | 'canceled'
  | 'expired'
  | 'price_change';

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La suscripción no existe.', HttpStatus.NOT_FOUND);

const unavailable = (): AppException =>
  new AppException(
    ErrorCode.BILLING_UNAVAILABLE,
    'No pudimos conectar con la pasarela de pagos. Intenta en unos minutos.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );

/**
 * Suscripciones de barberías y barberos independientes (Fase 15).
 *
 * Estados: PENDING (enlace de pago enviado) → TRIALING (prueba) o ACTIVE → PAST_DUE (cobro
 * fallido, con días de gracia) → EXPIRED (baja al plan gratis). CANCELED conserva el plan hasta
 * el fin del periodo pagado. El plan se contrata con un enlace web de la pasarela que se envía por
 * correo (las tiendas de apps no permiten venderlo dentro de la app).
 */
@Injectable()
export class SubscriptionsService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly entitlements: EntitlementsService,
    private readonly enforcement: PlanEnforcementService,
    private readonly webhooks: BillingWebhooksService,
    @Inject(BILLING_GATEWAY) private readonly gateway: BillingGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly balance: BalanceService,
  ) {}

  onModuleInit(): void {
    this.webhooks.register('sub', {
      onSubscription: (tx, id, event) => this.onSubscription(tx, id, event),
      onPayment: (tx, id, event) => this.onPayment(tx, id, event),
    });
  }

  // ───────────── Barbería (OWNER y MANAGER leen; solo OWNER contrata) ─────────────

  async summary(userId: string, barbershopId: string): Promise<BarbershopPlanDto> {
    await this.access.requireMember(userId, barbershopId);
    const effective = await this.entitlements.effective(barbershopId);
    const [plan, subscription, usage, suspendedBarbers, hiddenPhotos] = await Promise.all([
      effective.plan
        ? this.prisma.plan.findUnique({
            where: { id: effective.plan.id },
            include: { entitlements: { select: { key: true, value: true } } },
          })
        : null,
      this.current(barbershopId),
      this.usage(barbershopId),
      this.prisma.barber.count({
        where: { barbershopId, planSuspendedAt: { not: null }, deletedAt: null },
      }),
      this.prisma.image.count({
        where: { barbershopId, planHiddenAt: { not: null }, deletedAt: null },
      }),
    ]);
    return {
      plan: plan ? toPlanDto(plan) : null,
      subscription: subscription ? toSubscriptionDto(subscription) : null,
      usage: ENTITLEMENT_CATALOG.map((d): PlanUsageDto => ({
        key: d.key,
        label: d.label,
        kind: d.kind,
        limit: limitOf(effective.values, d.key),
        used: usage[d.key] ?? null,
      })),
      suspendedBarbers,
      hiddenPhotos,
    };
  }

  /** Insignias públicas del plan (perfil de la barbería). */
  async publicBadges(barbershopId: string): Promise<PublicPlanBadgesDto> {
    await this.access.requirePublic(barbershopId);
    const effective = await this.entitlements.effective(barbershopId);
    // Sin planes configurados no hay insignia que ganar.
    return {
      verified: effective.values !== null && (effective.values.get('verified_badge') ?? 0) > 0,
    };
  }

  /** Uso actual de los límites medibles. */
  async usage(barbershopId: string): Promise<Partial<Record<EntitlementKey, number>>> {
    const monthStart = this.entitlements.monthStart();
    const [barbers, photos, featured, messages, clients, sales] = await Promise.all([
      this.prisma.barber.count({
        where: { barbershopId, isActive: true, deletedAt: null, endedAt: null },
      }),
      this.prisma.image.count({
        where: {
          barbershopId,
          kind: 'GALLERY',
          deletedAt: null,
          removedAt: null,
          planHiddenAt: null,
        },
      }),
      this.featuredDaysUsed(barbershopId, monthStart),
      this.prisma.message.count({
        where: {
          side: 'BARBERSHOP',
          createdAt: { gte: monthStart },
          conversation: { barbershopId },
        },
      }),
      this.prisma.shopClient.count({ where: { barbershopId, archivedAt: null } }),
      this.prisma.localSale.count({ where: { barbershopId, soldAt: { gte: monthStart } } }),
    ]);
    return {
      barbers,
      gallery_photos: photos,
      featured_days_month: featured,
      messages_month: messages,
      crm_clients: clients,
      local_sales_month: sales,
    };
  }

  /** Días destacados del plan usados en el mes (los asignados por ADMIN no cuentan). */
  async featuredDaysUsed(barbershopId: string, monthStart: Date): Promise<number> {
    const rows = await this.prisma.featuredListing.findMany({
      where: { barbershopId, fromPlan: true, cancelledAt: null, startsAt: { gte: monthStart } },
      select: { startsAt: true, endsAt: true },
    });
    return rows.reduce(
      (sum, r) => sum + Math.ceil((r.endsAt.getTime() - r.startsAt.getTime()) / DAY_MS),
      0,
    );
  }

  async currentDto(userId: string, barbershopId: string): Promise<SubscriptionDto | null> {
    await this.access.requireMember(userId, barbershopId);
    const sub = await this.current(barbershopId);
    return sub ? toSubscriptionDto(sub) : null;
  }

  private current(barbershopId: string): Promise<SubscriptionRow | null> {
    return this.prisma.subscription.findFirst({
      where: { barbershopId, status: { in: [...LIVE_STATUSES, 'CANCELED'] } },
      orderBy: [{ createdAt: 'desc' }],
      include: subscriptionInclude,
    });
  }

  /**
   * Contrata un plan de pago. Crea la suscripción en la pasarela y envía el enlace de pago por
   * correo al dueño. Con `replace`, la vigente se reemplaza cuando la nueva queda autorizada.
   */
  async subscribe(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    dto: SubscribeDto,
  ): Promise<SubscriptionDto> {
    await this.access.requireMember(actor.userId, barbershopId, ['OWNER']);
    const shop = await this.prisma.barbershop.findUniqueOrThrow({
      where: { id: barbershopId },
      select: { type: true, name: true },
    });
    const plan = await this.prisma.plan.findUnique({ where: { code: dto.planCode } });
    if (!plan || !plan.isActive || plan.audience !== audienceOf(shop.type)) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El plan no existe.', HttpStatus.NOT_FOUND);
    }
    const interval = dto.interval ?? 'MONTHLY';
    const price = interval === 'YEARLY' ? plan.priceYearly : plan.priceMonthly;
    if (price === null || price <= 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Ese plan no se contrata: es el plan gratis o no tiene opción anual.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'planCode', constraints: ['paidPlan'] }],
      );
    }
    const live = await this.prisma.subscription.findFirst({
      where: { barbershopId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
      select: { id: true },
    });
    if (live && !dto.replace) {
      throw new AppException(
        ErrorCode.SUBSCRIPTION_EXISTS,
        'Tu barbería ya tiene un plan vigente. Para cambiarlo, confirma el reemplazo.',
        HttpStatus.CONFLICT,
      );
    }
    if (dto.paymentMethod === 'BALANCE') {
      return this.subscribeWithBalance(actor, barbershopId, {
        plan,
        interval,
        price,
        replaces: live?.id ?? null,
      });
    }
    const email = await this.users.contactEmail(actor.userId);
    if (!email) throw notFound();
    // Prueba gratis: solo la primera vez que la barbería prueba un plan.
    const triedBefore = await this.prisma.subscription.count({
      where: { barbershopId, trialEndsAt: { not: null } },
    });
    const trialDays = triedBefore > 0 ? 0 : plan.trialDays;

    const sub = await this.prisma.$transaction(async (tx) => {
      // Un solo enlace pendiente a la vez.
      await tx.subscription.updateMany({
        where: { barbershopId, status: 'PENDING' },
        data: { status: 'EXPIRED', endedAt: new Date(this.clock.now()) },
      });
      const created = await tx.subscription.create({
        data: {
          planId: plan.id,
          barbershopId,
          payerUserId: actor.userId,
          interval,
          priceAmount: price,
          currency: plan.currency,
          provider: this.gateway.provider,
          metadata: { trialDays, ...(live ? { replaces: live.id } : {}) },
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'subscription.requested',
          entityType: 'subscription',
          entityId: created.id,
          changes: { plan: plan.code, interval, replaces: live?.id ?? null },
          ip: actor.ip ?? null,
        },
        tx,
      );
      return created;
    });

    let result: { providerSubscriptionId: string; checkoutUrl: string };
    try {
      result = await this.gateway.createSubscription({
        reference: billingReference('sub', sub.id),
        reason: `Plan ${plan.name} de Charles — ${shop.name}`,
        amount: price,
        currency: plan.currency,
        frequencyMonths: interval === 'YEARLY' ? 12 : 1,
        trialDays,
        payerEmail: email,
        backUrl: this.backUrl(),
        idempotencyKey: sub.id,
      });
    } catch (error) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'EXPIRED', endedAt: new Date(this.clock.now()) },
      });
      if (error instanceof BillingGatewayError) throw unavailable();
      throw error;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          providerSubscriptionId: result.providerSubscriptionId,
          checkoutUrl: result.checkoutUrl,
        },
      });
      await this.notice(tx, sub.id, 'checkout_ready');
    });
    return toSubscriptionDto(await this.load(sub.id));
  }

  // ───────────── Pago con el saldo a favor ─────────────

  private async subscribeWithBalance(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    input: {
      plan: { id: string; code: string; currency: string };
      interval: 'MONTHLY' | 'YEARLY';
      price: number;
      replaces: string | null;
    },
  ): Promise<SubscriptionDto> {
    const now = new Date(this.clock.now());
    const { id, replaced } = await this.prisma.$transaction(async (tx) => {
      const available = await this.balance.lockAvailable(tx, barbershopId);
      if (available < input.price) throw insufficient(available);
      let replaced: string | null = null;
      if (input.replaces) {
        const old = await tx.subscription.findUnique({
          where: { id: input.replaces },
          select: { providerSubscriptionId: true },
        });
        replaced = old?.providerSubscriptionId ?? null;
        await tx.subscription.updateMany({
          where: {
            id: input.replaces,
            status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] },
          },
          data: { status: 'EXPIRED', endedAt: now, cancelReason: 'Reemplazada por otro plan' },
        });
      }
      await tx.subscription.updateMany({
        where: { barbershopId, status: 'PENDING' },
        data: { status: 'EXPIRED', endedAt: now },
      });
      const created = await tx.subscription.create({
        data: {
          planId: input.plan.id,
          barbershopId,
          payerUserId: actor.userId,
          interval: input.interval,
          priceAmount: input.price,
          currency: input.plan.currency,
          provider: BALANCE_PROVIDER,
          status: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: addMonths(now, input.interval === 'YEARLY' ? 12 : 1),
          metadata: {
            paidWithBalance: true,
            ...(input.replaces ? { replaces: input.replaces } : {}),
          },
        },
        select: { id: true },
      });
      await this.chargeBalanceInTx(
        tx,
        created.id,
        barbershopId,
        input.price,
        input.plan.currency,
        now,
      );
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'subscription.paid_with_balance',
          entityType: 'subscription',
          entityId: created.id,
          changes: { plan: input.plan.code, interval: input.interval, amount: input.price },
          ip: actor.ip ?? null,
        },
        tx,
      );
      await this.notice(tx, created.id, 'activated');
      return { id: created.id, replaced };
    });
    if (replaced) {
      await this.cancelAtProvider(replaced).catch((error: unknown) =>
        this.logger.warn(
          `No se pudo cancelar la suscripción reemplazada: ${(error as Error).message}`,
        ),
      );
    }
    this.entitlements.invalidate(barbershopId);
    await this.enforcement.apply(barbershopId);
    return toSubscriptionDto(await this.load(id));
  }

  /** Descuenta el periodo del saldo: movimiento negativo y cobro PAID (proveedor BALANCE). */
  private async chargeBalanceInTx(
    tx: Tx,
    subscriptionId: string,
    barbershopId: string,
    amount: number,
    currency: string,
    now: Date,
  ): Promise<void> {
    const movement = await tx.balanceMovement.create({
      data: { barbershopId, type: 'SUBSCRIPTION_PAYMENT', amount: -amount, subscriptionId },
      select: { id: true },
    });
    await tx.billingCharge.create({
      data: {
        purpose: 'SUBSCRIPTION',
        subscriptionId,
        amount,
        currency,
        status: 'PAID',
        provider: BALANCE_PROVIDER,
        providerPaymentId: movement.id,
        paidAt: now,
      },
    });
  }

  /**
   * Solo OWNER: paga con el saldo el periodo siguiente de un plan pagado con saldo (lo adelanta) o
   * recupera uno vencido (PAST_DUE).
   */
  async payWithBalance(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
  ): Promise<SubscriptionDto> {
    await this.access.requireMember(actor.userId, barbershopId, ['OWNER']);
    const sub = await this.prisma.subscription.findFirst({
      where: { barbershopId, provider: BALANCE_PROVIDER, status: { in: ['ACTIVE', 'PAST_DUE'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) throw notFound();
    const result = await this.renewWithBalance(sub.id, actor.userId);
    if (!result.renewed) throw insufficient(result.available);
    return toSubscriptionDto(await this.load(sub.id));
  }

  /** Renueva un periodo con el saldo. Si no alcanza, no cambia nada y devuelve el disponible. */
  private async renewWithBalance(
    subscriptionId: string,
    actorId: string | null,
  ): Promise<{ renewed: boolean; available: number }> {
    const now = new Date(this.clock.now());
    const outcome = await this.prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
      const available = await this.balance.lockAvailable(tx, sub.barbershopId);
      if (available < sub.priceAmount)
        return { renewed: false, available, recovered: false, barbershopId: sub.barbershopId };
      const recovered = sub.status === 'PAST_DUE';
      // Adelanta desde el fin del periodo vigente; si venció, desde hoy.
      const start =
        !recovered && sub.currentPeriodEnd && sub.currentPeriodEnd > now
          ? sub.currentPeriodEnd
          : now;
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'ACTIVE',
          currentPeriodStart: start,
          currentPeriodEnd: addMonths(start, sub.interval === 'YEARLY' ? 12 : 1),
          pastDueSince: null,
          graceUntil: null,
        },
      });
      await this.chargeBalanceInTx(
        tx,
        sub.id,
        sub.barbershopId,
        sub.priceAmount,
        sub.currency,
        now,
      );
      await this.audit.record(
        {
          actorId,
          action: 'subscription.renewed_with_balance',
          entityType: 'subscription',
          entityId: sub.id,
          changes: { amount: sub.priceAmount },
        },
        tx,
      );
      if (recovered) await this.notice(tx, sub.id, 'recovered');
      return { renewed: true, available, recovered, barbershopId: sub.barbershopId };
    });
    if (outcome.renewed) {
      this.entitlements.invalidate(outcome.barbershopId);
      if (outcome.recovered) await this.enforcement.apply(outcome.barbershopId);
    }
    return { renewed: outcome.renewed, available: outcome.available };
  }

  /** Cancela: conserva el plan hasta el fin del periodo pagado. Un enlace pendiente se anula. */
  async cancel(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    reason: string | undefined,
  ): Promise<SubscriptionDto> {
    await this.access.requireMember(actor.userId, barbershopId, ['OWNER']);
    const sub = await this.prisma.subscription.findFirst({
      where: { barbershopId, status: { in: [...LIVE_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) throw notFound();
    await this.cancelAtProvider(sub.providerSubscriptionId);
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: sub.id },
        data:
          sub.status === 'PENDING'
            ? { status: 'EXPIRED', endedAt: now, canceledAt: now, cancelReason: reason || null }
            : {
                status: 'CANCELED',
                canceledAt: now,
                cancelAtPeriodEnd: true,
                cancelReason: reason || null,
              },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'subscription.canceled',
          entityType: 'subscription',
          entityId: sub.id,
          changes: { reason: reason || null },
          ip: actor.ip ?? null,
        },
        tx,
      );
      if (sub.status !== 'PENDING') await this.notice(tx, sub.id, 'canceled');
    });
    this.entitlements.invalidate(barbershopId);
    return toSubscriptionDto(await this.load(sub.id));
  }

  /** Consulta a la pasarela el estado de la suscripción pendiente o vigente (al volver del pago). */
  async sync(userId: string, barbershopId: string): Promise<SubscriptionDto | null> {
    await this.access.requireMember(userId, barbershopId);
    const sub = await this.prisma.subscription.findFirst({
      where: {
        barbershopId,
        status: { in: [...LIVE_STATUSES] },
        providerSubscriptionId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, providerSubscriptionId: true },
    });
    if (!sub?.providerSubscriptionId) return this.currentDto(userId, barbershopId);
    let state;
    try {
      state = await this.gateway.getSubscription(sub.providerSubscriptionId);
    } catch (error) {
      if (error instanceof BillingGatewayError) throw unavailable();
      throw error;
    }
    if (state.status !== 'NOT_FOUND' && state.status !== 'PENDING') {
      await this.webhooks.apply({
        kind: 'SUBSCRIPTION',
        providerEventId: `pre:${sub.providerSubscriptionId}:${state.status}`,
        providerSubscriptionId: sub.providerSubscriptionId,
        reference: billingReference('sub', sub.id),
        status: state.status,
      });
    }
    return this.currentDto(userId, barbershopId);
  }

  async chooseActiveBarbers(
    userId: string,
    barbershopId: string,
    barberIds: string[],
  ): Promise<BarbershopPlanDto> {
    await this.access.requireMember(userId, barbershopId, ['OWNER']);
    const limit = await this.entitlements.limit(barbershopId, 'barbers');
    const unique = [...new Set(barberIds)];
    if (limit !== null && unique.length > limit) {
      throw new AppException(
        ErrorCode.PLAN_LIMIT_REACHED,
        'Elegiste más barberos de los que permite tu plan.',
        HttpStatus.FORBIDDEN,
        [{ key: 'barbers', limit, used: unique.length }],
      );
    }
    const owned = await this.prisma.barber.count({
      where: { id: { in: unique }, barbershopId, deletedAt: null, endedAt: null },
    });
    if (owned !== unique.length) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'barberIds', constraints: ['barberOfBarbershop'] }],
      );
    }
    await this.enforcement.chooseActiveBarbers(barbershopId, unique, userId);
    return this.summary(userId, barbershopId);
  }

  /** Días destacados incluidos en el plan: la barbería los usa cuando quiere (dentro del mes). */
  async useFeaturedDays(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    dto: { startsAt?: Date; days: number },
  ): Promise<FeaturedFromPlanDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    const now = this.clock.now();
    const startsAt = dto.startsAt && dto.startsAt.getTime() > now ? dto.startsAt : new Date(now);
    const monthStart = this.entitlements.monthStart(startsAt.getTime());
    const used = await this.featuredDaysUsed(barbershopId, monthStart);
    await this.entitlements.assertWithin(barbershopId, 'featured_days_month', used, dto.days);
    const endsAt = new Date(startsAt.getTime() + dto.days * DAY_MS);
    const listing = await this.prisma.$transaction(async (tx) => {
      const created = await tx.featuredListing.create({
        data: {
          barbershopId,
          startsAt,
          endsAt,
          fromPlan: true,
          createdById: actor.userId,
          note: 'Días del plan',
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'featured.plan_days_used',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: { days: dto.days, startsAt: startsAt.toISOString() },
          ip: actor.ip ?? null,
        },
        tx,
      );
      return created;
    });
    return {
      id: listing.id,
      startsAt,
      endsAt,
      daysUsed: used + dto.days,
      daysLimit: await this.entitlements.limit(barbershopId, 'featured_days_month'),
    };
  }

  // ───────────── Avisos de la pasarela ─────────────

  private async onSubscription(
    tx: Tx,
    id: string,
    event: BillingSubscriptionEvent,
  ): Promise<AfterCommit | void> {
    const sub = await tx.subscription.findUnique({ where: { id } });
    if (!sub) return;
    const now = new Date(this.clock.now());
    const barbershopId = sub.barbershopId;
    if (event.status === 'AUTHORIZED' && sub.status === 'PENDING') {
      const trialDays = Number((sub.metadata as { trialDays?: number }).trialDays ?? 0);
      const replaces = (sub.metadata as { replaces?: string }).replaces ?? null;
      let replaced: { providerSubscriptionId: string | null } | null = null;
      if (replaces) {
        replaced = await tx.subscription.findUnique({
          where: { id: replaces },
          select: { providerSubscriptionId: true },
        });
        await tx.subscription.updateMany({
          where: { id: replaces, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] } },
          data: { status: 'EXPIRED', endedAt: now, cancelReason: 'Reemplazada por otro plan' },
        });
      }
      const trialEnd = trialDays > 0 ? new Date(now.getTime() + trialDays * DAY_MS) : null;
      await tx.subscription.update({
        where: { id },
        data: trialEnd
          ? {
              status: 'TRIALING',
              trialEndsAt: trialEnd,
              currentPeriodStart: now,
              currentPeriodEnd: trialEnd,
            }
          : {
              status: 'ACTIVE',
              currentPeriodStart: now,
              currentPeriodEnd: addMonths(now, sub.interval === 'YEARLY' ? 12 : 1),
            },
      });
      await this.notice(tx, id, 'activated');
      return async () => {
        if (replaced?.providerSubscriptionId)
          await this.cancelAtProvider(replaced.providerSubscriptionId);
        await this.enforcement.apply(barbershopId);
      };
    }
    if (event.status === 'CANCELLED') {
      if (sub.status === 'PENDING') {
        await tx.subscription.update({ where: { id }, data: { status: 'EXPIRED', endedAt: now } });
        return;
      }
      if (sub.status === 'TRIALING' || sub.status === 'ACTIVE' || sub.status === 'PAST_DUE') {
        await tx.subscription.update({
          where: { id },
          data: { status: 'CANCELED', canceledAt: now, cancelAtPeriodEnd: true },
        });
        await this.notice(tx, id, 'canceled');
        return () => Promise.resolve(this.entitlements.invalidate(barbershopId));
      }
    }
    if (event.status === 'PAUSED' && (sub.status === 'ACTIVE' || sub.status === 'TRIALING')) {
      await this.markPastDue(tx, sub.id, now, 'Pausada en la pasarela');
      return () => Promise.resolve(this.entitlements.invalidate(barbershopId));
    }
  }

  private async onPayment(
    tx: Tx,
    id: string,
    event: BillingPaymentEvent,
  ): Promise<AfterCommit | void> {
    const sub = await tx.subscription.findUnique({ where: { id } });
    if (!sub) return;
    const now = new Date(this.clock.now());
    const status =
      event.outcome === 'PAID' ? 'PAID' : event.outcome === 'FAILED' ? 'FAILED' : 'PENDING';
    await tx.billingCharge.upsert({
      where: {
        provider_providerPaymentId: {
          provider: this.gateway.provider,
          providerPaymentId: event.providerPaymentId,
        },
      },
      create: {
        purpose: 'SUBSCRIPTION',
        subscriptionId: id,
        amount: event.amount,
        currency: event.currency,
        status,
        provider: this.gateway.provider,
        providerPaymentId: event.providerPaymentId,
        failureReason: event.failureReason,
        paidAt: status === 'PAID' ? now : null,
      },
      update: {
        status,
        failureReason: event.failureReason,
        paidAt: status === 'PAID' ? now : null,
      },
    });
    const barbershopId = sub.barbershopId;
    if (status === 'PAID' && ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE'].includes(sub.status)) {
      const recovered = sub.status === 'PAST_DUE';
      await tx.subscription.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: addMonths(now, sub.interval === 'YEARLY' ? 12 : 1),
          pastDueSince: null,
          graceUntil: null,
        },
      });
      if (recovered) await this.notice(tx, id, 'recovered');
      return async () => {
        this.entitlements.invalidate(barbershopId);
        if (recovered) await this.enforcement.apply(barbershopId);
      };
    }
    if (status === 'FAILED' && (sub.status === 'ACTIVE' || sub.status === 'TRIALING')) {
      await this.markPastDue(tx, id, now, event.failureReason);
      return () => Promise.resolve(this.entitlements.invalidate(barbershopId));
    }
  }

  private async markPastDue(tx: Tx, id: string, now: Date, reason: string | null): Promise<void> {
    const graceDays = await this.settings.positiveInt(
      SettingKey.BILLING_GRACE_DAYS,
      BILLING_DEFAULTS.graceDays,
    );
    await tx.subscription.update({
      where: { id },
      data: {
        status: 'PAST_DUE',
        pastDueSince: now,
        graceUntil: new Date(now.getTime() + graceDays * DAY_MS),
        metadata: { lastFailure: reason },
      },
    });
    await this.notice(tx, id, 'payment_failed');
  }

  // ───────────── Trabajo periódico ─────────────

  /** Fin de gracias, de cancelaciones y de enlaces sin usar; avisos de prueba; cambios de precio. */
  async runMaintenance(): Promise<{ expired: number; noticed: number; repriced: number }> {
    const now = new Date(this.clock.now());
    let expired = 0;
    // Planes pagados con saldo: al vencer el periodo se renuevan con el saldo; si no alcanza,
    // quedan PAST_DUE (con días de gracia) y el dueño puede pagar con saldo o por pasarela.
    const dueBalance = await this.prisma.subscription.findMany({
      where: { provider: BALANCE_PROVIDER, status: 'ACTIVE', currentPeriodEnd: { lte: now } },
      select: { id: true, barbershopId: true },
      take: 200,
    });
    for (const sub of dueBalance) {
      const { renewed } = await this.renewWithBalance(sub.id, null);
      if (!renewed) {
        await this.prisma.$transaction((tx) =>
          this.markPastDue(tx, sub.id, now, 'Saldo insuficiente'),
        );
        this.entitlements.invalidate(sub.barbershopId);
      }
    }
    const ending = await this.prisma.subscription.findMany({
      where: {
        OR: [
          { status: 'PAST_DUE', graceUntil: { lt: now } },
          {
            status: 'CANCELED',
            OR: [
              { currentPeriodEnd: { lt: now } },
              { currentPeriodEnd: null, trialEndsAt: { lt: now } },
            ],
          },
          { status: 'CANCELED', currentPeriodEnd: null, trialEndsAt: null },
        ],
      },
      select: { id: true, status: true, barbershopId: true, providerSubscriptionId: true },
      take: 200,
    });
    for (const sub of ending) {
      if (sub.status === 'PAST_DUE') {
        try {
          await this.cancelAtProvider(sub.providerSubscriptionId);
        } catch (error) {
          this.logger.warn(
            `No se pudo cancelar ${sub.id} en la pasarela: ${(error as Error).message}`,
          );
          continue;
        }
      }
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.subscription.updateMany({
          where: { id: sub.id, status: sub.status },
          data: { status: 'EXPIRED', endedAt: now },
        });
        if (count > 0) await this.notice(tx, sub.id, 'expired');
      });
      if (sub.barbershopId) await this.enforcement.apply(sub.barbershopId);
      expired++;
    }
    const abandoned = await this.prisma.subscription.updateMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - PENDING_TTL_MS) } },
      data: { status: 'EXPIRED', endedAt: now },
    });

    const noticeDays = await this.settings.positiveInt(
      SettingKey.BILLING_TRIAL_NOTICE_DAYS,
      BILLING_DEFAULTS.trialNoticeDays,
    );
    const trials = await this.prisma.subscription.findMany({
      where: {
        status: 'TRIALING',
        trialEndsAt: { gt: now, lte: new Date(now.getTime() + noticeDays * DAY_MS) },
        NOT: { metadata: { path: ['trialNoticeSent'], equals: true } },
      },
      select: { id: true, metadata: true },
      take: 200,
    });
    for (const sub of trials) {
      await this.prisma.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: sub.id },
          data: { metadata: { ...(sub.metadata as object), trialNoticeSent: true } },
        });
        await this.notice(tx, sub.id, 'trial_ending');
      });
    }

    let repriced = 0;
    const due = await this.prisma.subscription.findMany({
      where: { nextPriceFrom: { lte: now }, nextPriceAmount: { not: null } },
      select: { id: true, providerSubscriptionId: true, nextPriceAmount: true, currency: true },
      take: 200,
    });
    for (const sub of due) {
      try {
        if (sub.providerSubscriptionId) {
          await this.gateway.updateSubscriptionAmount(
            sub.providerSubscriptionId,
            sub.nextPriceAmount!,
            sub.currency,
          );
        }
      } catch (error) {
        this.logger.warn(`No se pudo cambiar el precio de ${sub.id}: ${(error as Error).message}`);
        continue;
      }
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { priceAmount: sub.nextPriceAmount!, nextPriceAmount: null, nextPriceFrom: null },
      });
      repriced++;
    }
    return { expired: expired + abandoned.count, noticed: trials.length, repriced };
  }

  // ───────────── ADMIN ─────────────

  async adminList(query: {
    status?: string;
    barbershopId?: string;
  }): Promise<AdminSubscriptionDto[]> {
    const rows = await this.prisma.subscription.findMany({
      where: {
        ...(query.status ? { status: query.status as SubscriptionRow['status'] } : {}),
        ...(query.barbershopId ? { barbershopId: query.barbershopId } : {}),
      },
      include: { ...subscriptionInclude, barbershop: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toAdmin(r));
  }

  private toAdmin(
    r: SubscriptionRow & { barbershop: { id: string; name: string } | null },
  ): AdminSubscriptionDto {
    return {
      ...toSubscriptionDto(r),
      barbershopId: r.barbershop?.id ?? '',
      barbershopName: r.barbershop?.name ?? '',
      canceledAt: r.canceledAt,
      cancelReason: r.cancelReason,
    };
  }

  /** Resumen de facturación de Charles (planes, cobros y comisiones del mes). */
  async billingSummary(): Promise<BillingSummaryDto> {
    const monthStart = this.entitlements.monthStart();
    const [live, grouped, charges, commissions, plans] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { status: { in: ['ACTIVE', 'PAST_DUE'] } },
        select: { priceAmount: true, interval: true },
      }),
      this.prisma.subscription.groupBy({
        by: ['planId', 'status'],
        where: { status: { in: ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] } },
        _count: { _all: true },
      }),
      this.prisma.billingCharge.groupBy({
        by: ['purpose'],
        where: { status: 'PAID', paidAt: { gte: monthStart } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.booking.aggregate({
        where: { status: { in: ['CONFIRMED', 'ATTENDED'] }, createdAt: { gte: monthStart } },
        _sum: { commissionAmount: true },
      }),
      this.prisma.plan.findMany({ select: { id: true, code: true, name: true } }),
    ]);
    const planById = new Map(plans.map((p) => [p.id, p]));
    return {
      mrr: live.reduce(
        (sum, s) =>
          sum + (s.interval === 'YEARLY' ? Math.round(s.priceAmount / 12) : s.priceAmount),
        0,
      ),
      pastDue: grouped
        .filter((g) => g.status === 'PAST_DUE')
        .reduce((n, g) => n + g._count._all, 0),
      trialing: grouped
        .filter((g) => g.status === 'TRIALING')
        .reduce((n, g) => n + g._count._all, 0),
      byPlan: grouped.map((g) => ({
        planCode: planById.get(g.planId)?.code ?? '',
        planName: planById.get(g.planId)?.name ?? '',
        status: g.status,
        count: g._count._all,
      })),
      chargesThisMonth: charges.map((c) => ({
        purpose: c.purpose,
        amount: c._sum.amount ?? 0,
        count: c._count._all,
      })),
      commissionsThisMonth: commissions._sum.commissionAmount ?? 0,
    };
  }

  /** ADMIN cancela de inmediato (baja al plan gratis ahora). */
  async adminCancel(actorId: string, id: string, reason: string): Promise<AdminSubscriptionDto> {
    const sub = await this.prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw notFound();
    if (sub.status === 'EXPIRED') return this.adminOne(id);
    await this.cancelAtProvider(sub.providerSubscriptionId);
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id },
        data: {
          status: 'EXPIRED',
          endedAt: now,
          canceledAt: sub.canceledAt ?? now,
          cancelReason: reason,
        },
      });
      await this.audit.record(
        {
          actorId,
          action: 'subscription.admin_canceled',
          entityType: 'subscription',
          entityId: id,
          changes: { reason },
        },
        tx,
      );
      await this.notice(tx, id, 'expired');
    });
    if (sub.barbershopId) await this.enforcement.apply(sub.barbershopId, actorId);
    return this.adminOne(id);
  }

  /** ADMIN regala días: se suman al periodo (o a la prueba, o a la gracia). */
  async adminExtend(
    actorId: string,
    id: string,
    days: number,
    reason: string,
  ): Promise<AdminSubscriptionDto> {
    const sub = await this.prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw notFound();
    if (!['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'].includes(sub.status)) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Esa suscripción no está vigente.',
        HttpStatus.CONFLICT,
      );
    }
    const plus = (d: Date | null) => (d ? new Date(d.getTime() + days * DAY_MS) : null);
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id },
        data: {
          currentPeriodEnd: plus(sub.currentPeriodEnd),
          trialEndsAt: sub.status === 'TRIALING' ? plus(sub.trialEndsAt) : undefined,
          graceUntil: sub.status === 'PAST_DUE' ? plus(sub.graceUntil) : undefined,
        },
      });
      await this.audit.record(
        {
          actorId,
          action: 'subscription.extended',
          entityType: 'subscription',
          entityId: id,
          changes: { days, reason },
        },
        tx,
      );
    });
    if (sub.barbershopId) this.entitlements.invalidate(sub.barbershopId);
    return this.adminOne(id);
  }

  private async adminOne(id: string): Promise<AdminSubscriptionDto> {
    const row = await this.prisma.subscription.findUnique({
      where: { id },
      include: { ...subscriptionInclude, barbershop: { select: { id: true, name: true } } },
    });
    if (!row) throw notFound();
    return this.toAdmin(row);
  }

  // ───────────── Apoyo ─────────────

  private async load(id: string): Promise<SubscriptionRow> {
    return this.prisma.subscription.findUniqueOrThrow({
      where: { id },
      include: subscriptionInclude,
    });
  }

  private async cancelAtProvider(providerSubscriptionId: string | null): Promise<void> {
    if (!providerSubscriptionId) return;
    try {
      await this.gateway.cancelSubscription(providerSubscriptionId);
    } catch (error) {
      if (error instanceof BillingGatewayError) throw unavailable();
      throw error;
    }
  }

  private async notice(tx: Tx, subscriptionId: string, notice: SubscriptionNotice): Promise<void> {
    await this.outbox.publish(tx, SUBSCRIPTION_NOTICE_EVENT, { subscriptionId, notice });
  }

  private backUrl(): string {
    return `${this.config.payments.publicApiUrl ?? 'https://charles.invalid'}${BACK_PATH}`;
  }
}
