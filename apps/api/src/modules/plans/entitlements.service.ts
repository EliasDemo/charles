import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { PlanAudience, SubscriptionStatus } from '../../generated/prisma/enums';
import {
  type EntitlementKey,
  type EntitlementValues,
  ENTITLEMENT_CATALOG,
  hasFeature,
  limitOf,
} from './entitlements';

/** Estados de una suscripción que dan los beneficios de su plan. */
export const EFFECTIVE_STATUSES: SubscriptionStatus[] = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
];
const CACHE_MS = 30_000;

export interface EffectivePlan {
  /** null: no hay planes configurados para este tipo de barbería (sin límites). */
  plan: {
    id: string;
    code: string;
    name: string;
    audience: PlanAudience;
    commissionBp: number | null;
    isDefault: boolean;
  } | null;
  subscriptionId: string | null;
  values: EntitlementValues | null;
}

export const audienceOf = (type: string): PlanAudience =>
  type === 'INDEPENDENT' ? 'BARBER' : 'BARBERSHOP';

/**
 * Derechos de una barbería según su plan (Fase 15). **Única** fuente que consultan los demás
 * módulos. Una barbería sin suscripción vigente tiene el plan por defecto (gratis) de su tipo;
 * si no hay planes configurados, todo es ilimitado (como antes de la Fase 15).
 *
 * Caché en memoria de 30 s por barbería; `invalidate` al cambiar de plan.
 */
@Injectable()
export class EntitlementsService {
  private readonly cache = new Map<string, { at: number; value: EffectivePlan }>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  invalidate(barbershopId?: string): void {
    if (barbershopId) this.cache.delete(barbershopId);
    else this.cache.clear();
  }

  async effective(barbershopId: string): Promise<EffectivePlan> {
    const now = this.clock.now();
    const hit = this.cache.get(barbershopId);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = await this.load(barbershopId, now);
    this.cache.set(barbershopId, { at: now, value });
    return value;
  }

  private async load(barbershopId: string, now: number): Promise<EffectivePlan> {
    const shop = await this.prisma.barbershop.findUnique({
      where: { id: barbershopId },
      select: { type: true },
    });
    const audience = audienceOf(shop?.type ?? 'BARBERSHOP');
    const nowDate = new Date(now);
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        barbershopId,
        status: { in: EFFECTIVE_STATUSES },
        plan: { audience },
        // Cancelada: conserva el plan hasta el fin del periodo (o de la prueba) ya pagado.
        OR: [
          { status: { not: 'CANCELED' } },
          { currentPeriodEnd: { gt: nowDate } },
          { trialEndsAt: { gt: nowDate } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, plan: { select: planSelect } },
    });
    const plan =
      subscription?.plan ??
      (await this.prisma.plan.findFirst({
        where: { audience, isDefault: true, isActive: true },
        select: planSelect,
      }));
    if (!plan) return { plan: null, subscriptionId: null, values: null };
    return {
      plan: {
        id: plan.id,
        code: plan.code,
        name: plan.name,
        audience: plan.audience,
        commissionBp: plan.commissionBp,
        isDefault: plan.isDefault,
      },
      subscriptionId: subscription?.id ?? null,
      values: new Map(plan.entitlements.map((e) => [e.key, e.value])),
    };
  }

  async has(barbershopId: string, key: EntitlementKey): Promise<boolean> {
    return hasFeature((await this.effective(barbershopId)).values, key);
  }

  async limit(barbershopId: string, key: EntitlementKey): Promise<number | null> {
    return limitOf((await this.effective(barbershopId)).values, key);
  }

  /** Comisión por reserva del plan (null: la general de Ajustes). */
  async commissionBp(barbershopId: string): Promise<number | null> {
    return (await this.effective(barbershopId)).plan?.commissionBp ?? null;
  }

  async assertFeature(barbershopId: string, key: EntitlementKey): Promise<void> {
    if (await this.has(barbershopId, key)) return;
    throw new AppException(
      ErrorCode.PLAN_FEATURE_NOT_INCLUDED,
      'Tu plan no incluye esta función. Mejora tu plan para usarla.',
      HttpStatus.FORBIDDEN,
      [{ key }],
    );
  }

  /** Lanza si `used + adding` supera el límite. */
  async assertWithin(
    barbershopId: string,
    key: EntitlementKey,
    used: number,
    adding = 1,
  ): Promise<void> {
    const limit = await this.limit(barbershopId, key);
    if (limit === null || used + adding <= limit) return;
    throw limitReached(key, limit, used);
  }

  /** Inicio del mes calendario de Lima (para los límites mensuales). */
  monthStart(now = this.clock.now()): Date {
    const lima = new Date(now - 5 * 3_600_000);
    return new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), 1, 5));
  }

  catalog(): typeof ENTITLEMENT_CATALOG {
    return ENTITLEMENT_CATALOG;
  }
}

export const limitReached = (key: EntitlementKey, limit: number, used: number): AppException =>
  new AppException(
    ErrorCode.PLAN_LIMIT_REACHED,
    'Llegaste al límite de tu plan. Mejora tu plan para continuar.',
    HttpStatus.FORBIDDEN,
    [{ key, limit, used }],
  );

const planSelect = {
  id: true,
  code: true,
  name: true,
  audience: true,
  commissionBp: true,
  isDefault: true,
  entitlements: { select: { key: true, value: true } },
} satisfies Prisma.PlanSelect;
