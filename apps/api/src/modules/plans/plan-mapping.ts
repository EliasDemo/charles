import type { Prisma } from '../../generated/prisma/client';
import { ENTITLEMENT_CATALOG } from './entitlements';
import type { PlanDto, SubscriptionDto } from './dto/plan.dto';

export const planInclude = {
  entitlements: { select: { key: true, value: true } },
} satisfies Prisma.PlanInclude;

export type PlanRow = Prisma.PlanGetPayload<{ include: typeof planInclude }>;

export function toPlanDto(plan: PlanRow): PlanDto {
  const values = new Map(plan.entitlements.map((e) => [e.key, e.value]));
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    audience: plan.audience,
    priceMonthly: plan.priceMonthly,
    priceYearly: plan.priceYearly,
    currency: plan.currency,
    trialDays: plan.trialDays,
    commissionBp: plan.commissionBp,
    isDefault: plan.isDefault,
    // Todas las claves del catálogo, en su orden; las ausentes, no incluidas (0).
    entitlements: ENTITLEMENT_CATALOG.map((d) => ({
      key: d.key,
      kind: d.kind,
      label: d.label,
      value: values.has(d.key) ? (values.get(d.key) ?? null) : 0,
    })),
  };
}

export const subscriptionInclude = {
  plan: { include: planInclude },
} satisfies Prisma.SubscriptionInclude;

export type SubscriptionRow = Prisma.SubscriptionGetPayload<{
  include: typeof subscriptionInclude;
}>;

export function toSubscriptionDto(sub: SubscriptionRow): SubscriptionDto {
  return {
    id: sub.id,
    status: sub.status,
    interval: sub.interval,
    plan: toPlanDto(sub.plan),
    priceAmount: sub.priceAmount,
    currency: sub.currency,
    nextPriceAmount: sub.nextPriceAmount,
    nextPriceFrom: sub.nextPriceFrom,
    checkoutUrl: sub.status === 'PENDING' ? sub.checkoutUrl : null,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodEnd: sub.currentPeriodEnd,
    graceUntil: sub.status === 'PAST_DUE' ? sub.graceUntil : null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    createdAt: sub.createdAt,
  };
}
