import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { DAY_MS } from '../billing/billing-gateway';
import type {
  AdminPlanDto,
  CreatePlanDto,
  PlanDto,
  SetEntitlementsDto,
  UpdatePlanDto,
} from './dto/plan.dto';
import { isEntitlementKey, normalizeEntitlement } from './entitlements';
import { EntitlementsService } from './entitlements.service';
import { planInclude, toPlanDto } from './plan-mapping';

export const LIVE_STATUSES = ['PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE'] as const;
export const BILLING_DEFAULTS = { graceDays: 7, trialNoticeDays: 3, priceChangeNoticeDays: 30 };
export const SUBSCRIPTION_NOTICE_EVENT = 'billing.subscription';

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El plan no existe.', HttpStatus.NOT_FOUND);

const invalid = (
  field: string,
  constraint: string,
  message = 'Los datos enviados no son válidos.',
) =>
  new AppException(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, [
    { field, constraints: [constraint] },
  ]);

/** Planes como datos (Fase 15): catálogo público y administración por ADMIN, con auditoría. */
@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
    private readonly entitlements: EntitlementsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Planes que se ofrecen (visibles y activos), por orden. */
  async publicList(audience?: 'BARBERSHOP' | 'BARBER'): Promise<PlanDto[]> {
    const rows = await this.prisma.plan.findMany({
      where: { isVisible: true, isActive: true, ...(audience ? { audience } : {}) },
      include: planInclude,
      orderBy: [{ audience: 'asc' }, { sortOrder: 'asc' }, { priceMonthly: 'asc' }],
    });
    return rows.map(toPlanDto);
  }

  async adminList(): Promise<AdminPlanDto[]> {
    const rows = await this.prisma.plan.findMany({
      include: {
        ...planInclude,
        _count: { select: { subscriptions: { where: { status: { in: [...LIVE_STATUSES] } } } } },
      },
      orderBy: [{ audience: 'asc' }, { sortOrder: 'asc' }, { priceMonthly: 'asc' }],
    });
    return rows.map((r) => ({
      ...toPlanDto(r),
      sortOrder: r.sortOrder,
      isVisible: r.isVisible,
      isActive: r.isActive,
      liveSubscriptions: r._count.subscriptions,
    }));
  }

  private async adminOne(id: string): Promise<AdminPlanDto> {
    const found = (await this.adminList()).find((p) => p.id === id);
    if (!found) throw notFound();
    return found;
  }

  async create(actorId: string, dto: CreatePlanDto): Promise<AdminPlanDto> {
    if (dto.isDefault && dto.priceMonthly !== 0) throw invalid('isDefault', 'defaultMustBeFree');
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault) await this.clearDefault(tx, dto.audience);
        const plan = await tx.plan.create({
          data: {
            code: dto.code,
            name: dto.name,
            description: dto.description || null,
            audience: dto.audience,
            priceMonthly: dto.priceMonthly,
            priceYearly: dto.priceYearly ?? null,
            trialDays: dto.trialDays ?? 0,
            commissionBp: dto.commissionBp ?? null,
            sortOrder: dto.sortOrder ?? 0,
            isDefault: dto.isDefault ?? false,
            isVisible: dto.isVisible ?? true,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorId,
            action: 'plan.created',
            entityType: 'plan',
            entityId: plan.id,
            changes: { code: dto.code, audience: dto.audience, priceMonthly: dto.priceMonthly },
          },
          tx,
        );
        return plan.id;
      });
      this.entitlements.invalidate();
      return this.adminOne(id);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Ya existe un plan con ese código.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /**
   * Edita un plan. Un precio nuevo aplica de inmediato a las suscripciones nuevas; las vigentes lo
   * pagan desde su renovación, con al menos `billing.price_change_notice_days` de aviso.
   */
  async update(actorId: string, id: string, dto: UpdatePlanDto): Promise<AdminPlanDto> {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw notFound();
    const nextMonthly = dto.priceMonthly ?? plan.priceMonthly;
    if ((dto.isDefault ?? plan.isDefault) && nextMonthly !== 0) {
      throw invalid('isDefault', 'defaultMustBeFree');
    }
    const priceChanges = {
      MONTHLY:
        dto.priceMonthly !== undefined && dto.priceMonthly !== plan.priceMonthly
          ? dto.priceMonthly
          : null,
      YEARLY:
        dto.priceYearly !== undefined &&
        dto.priceYearly !== null &&
        dto.priceYearly !== plan.priceYearly
          ? dto.priceYearly
          : null,
    };
    const noticeDays = await this.settings.positiveInt(
      SettingKey.BILLING_PRICE_CHANGE_NOTICE_DAYS,
      BILLING_DEFAULTS.priceChangeNoticeDays,
    );
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await this.clearDefault(tx, plan.audience);
      await tx.plan.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description === undefined ? undefined : dto.description || null,
          priceMonthly: dto.priceMonthly,
          priceYearly: dto.priceYearly,
          trialDays: dto.trialDays,
          commissionBp: dto.commissionBp,
          sortOrder: dto.sortOrder,
          isVisible: dto.isVisible,
          isActive: dto.isActive,
          isDefault: dto.isDefault,
        },
      });
      for (const interval of ['MONTHLY', 'YEARLY'] as const) {
        const price = priceChanges[interval];
        if (price === null) continue;
        const subs = await tx.subscription.findMany({
          where: { planId: id, interval, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
          select: { id: true, currentPeriodEnd: true },
        });
        for (const sub of subs) {
          const from = Math.max(sub.currentPeriodEnd?.getTime() ?? now, now + noticeDays * DAY_MS);
          await tx.subscription.update({
            where: { id: sub.id },
            data: { nextPriceAmount: price, nextPriceFrom: new Date(from) },
          });
          await this.outbox.publish(tx, SUBSCRIPTION_NOTICE_EVENT, {
            subscriptionId: sub.id,
            notice: 'price_change',
          });
        }
      }
      await this.audit.record(
        {
          actorId,
          action: 'plan.updated',
          entityType: 'plan',
          entityId: id,
          changes: { ...withoutReason(dto), reason: dto.reason },
        },
        tx,
      );
    });
    this.entitlements.invalidate();
    return this.adminOne(id);
  }

  /** Reemplaza los beneficios del plan (las claves omitidas quedan no incluidas). */
  async setEntitlements(
    actorId: string,
    id: string,
    dto: SetEntitlementsDto,
  ): Promise<AdminPlanDto> {
    const plan = await this.prisma.plan.count({ where: { id } });
    if (!plan) throw notFound();
    const rows: { key: string; value: number | null }[] = [];
    for (const [key, raw] of Object.entries(dto.values)) {
      if (!isEntitlementKey(key)) throw invalid(`values.${key}`, 'unknownEntitlement');
      if (raw !== null && typeof raw !== 'number' && typeof raw !== 'boolean') {
        throw invalid(`values.${key}`, 'numberOrNull');
      }
      rows.push({ key, value: normalizeEntitlement(key, raw) });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.planEntitlement.deleteMany({ where: { planId: id } });
      if (rows.length > 0) {
        await tx.planEntitlement.createMany({ data: rows.map((r) => ({ planId: id, ...r })) });
      }
      await this.audit.record(
        {
          actorId,
          action: 'plan.entitlements_set',
          entityType: 'plan',
          entityId: id,
          changes: {
            values: Object.fromEntries(rows.map((r) => [r.key, r.value])),
            reason: dto.reason,
          },
        },
        tx,
      );
    });
    this.entitlements.invalidate();
    return this.adminOne(id);
  }

  /** Solo sin suscripciones (vivas o pasadas); si las tiene, se oculta (`isVisible: false`). */
  async remove(actorId: string, id: string, reason: string): Promise<void> {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      select: { id: true, _count: { select: { subscriptions: true } } },
    });
    if (!plan) throw notFound();
    if (plan._count.subscriptions > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'El plan tiene suscripciones: ocúltalo en lugar de eliminarlo.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.plan.delete({ where: { id } });
      await this.audit.record(
        { actorId, action: 'plan.deleted', entityType: 'plan', entityId: id, changes: { reason } },
        tx,
      );
    });
    this.entitlements.invalidate();
  }

  private async clearDefault(
    tx: Prisma.TransactionClient,
    audience: 'BARBERSHOP' | 'BARBER',
  ): Promise<void> {
    await tx.plan.updateMany({ where: { audience, isDefault: true }, data: { isDefault: false } });
  }
}

function withoutReason(dto: UpdatePlanDto): Record<string, unknown> {
  const { reason: _reason, ...rest } = dto;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
}
