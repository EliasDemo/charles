import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import {
  type BookingContext,
  type ChosenDiscount,
  chooseBest,
  appliesTo,
  discountAmount,
  parseRules,
  type PromotionCandidate,
} from './discount-policy';
import {
  type CouponRejection,
  type CreateCouponDto,
  type CreatePromotionDto,
  FIXED_AMOUNT_LIMITS,
  type PromotionDto,
  type PublicPromotionDto,
  type QuoteCouponDto,
  type UpdatePromotionDto,
} from './dto/promotion.dto';

type Db = Prisma.TransactionClient | PrismaService;

/** Moneda de las promociones de monto fijo (los servicios se cobran en soles). */
const PROMOTION_CURRENCY = 'PEN';
/** Cupones por promoción. */
const MAX_COUPONS_PER_PROMOTION = 50;

export interface ResolveInput {
  clientId: string | null;
  barbershopId: string;
  serviceId: string;
  subtotal: number;
  currency: string;
  startAt: number;
  timezone: string;
  couponCode?: string | null;
}

export interface Resolution {
  discount: ChosenDiscount | null;
  /** Cupón con el que se canjea (si el descuento elegido es el del cupón). */
  couponId: string | null;
  coupon: QuoteCouponDto | null;
}

export interface Actor {
  userId: string;
  ip?: string | null;
}

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La promoción no existe.', HttpStatus.NOT_FOUND);

const invalid = (
  field: string,
  constraint: string,
  message = 'Los datos enviados no son válidos.',
) =>
  new AppException(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, [
    { field, constraints: [constraint] },
  ]);

/** Cupón que no se puede usar al reservar (en la cotización se informa sin error). */
export const couponNotValid = (reason: CouponRejection): AppException =>
  new AppException(
    ErrorCode.COUPON_NOT_VALID,
    {
      NOT_FOUND: 'Ese cupón no existe.',
      NOT_ACTIVE: 'Ese cupón no está vigente.',
      NOT_APPLICABLE: 'Ese cupón no aplica a esta reserva.',
      EXHAUSTED: 'Ese cupón ya no tiene usos disponibles.',
      ALREADY_USED: 'Ya usaste este cupón.',
    }[reason],
    HttpStatus.CONFLICT,
    [{ reason }],
  );

/**
 * Promociones y cupones (Fase 13): qué descuento lleva una reserva, el registro del canje (con
 * los topes controlados dentro de la transacción) y su administración por la barbería o ADMIN.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Descuento de una reserva ─────────────

  /**
   * Elige el descuento de una reserva. Con `lock`, bloquea las promociones candidatas (por id, orden
   * fijo) para que dos reservas no se lleven el último cupo: úsese dentro de la transacción de la
   * reserva, después de los demás bloqueos.
   */
  async resolve(db: Db, input: ResolveInput, options: { lock: boolean }): Promise<Resolution> {
    const now = new Date(this.clock.now());
    const code = input.couponCode?.trim().toUpperCase() || null;
    const coupon = code
      ? await db.coupon.findFirst({
          where: { code, deletedAt: null },
          select: {
            id: true,
            promotionId: true,
            promotion: { select: { scope: true, scopeId: true } },
          },
        })
      : null;

    const rows = await db.promotion.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        AND: [
          {
            OR: [
              { scope: 'PLATFORM' },
              { scope: 'BARBERSHOP', scopeId: input.barbershopId },
              { scope: 'SERVICE', scopeId: input.serviceId },
            ],
          },
          {
            OR: [{ requiresCoupon: false }, ...(coupon ? [{ id: coupon.promotionId }] : [])],
          },
        ],
      },
    });
    const ids = rows.map((r) => r.id).sort();
    if (options.lock && ids.length > 0) {
      await db.$queryRaw`
        SELECT id FROM promotions WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    }
    const usage = await this.usage(db, ids, input.clientId);
    const ctx: BookingContext = {
      barbershopId: input.barbershopId,
      serviceId: input.serviceId,
      subtotal: input.subtotal,
      currency: input.currency,
      dayOfWeek: DateTime.fromMillis(input.startAt, { zone: input.timezone }).weekday % 7,
    };

    const blocked = new Map<string, CouponRejection>();
    const eligible: PromotionCandidate[] = [];
    for (const row of rows) {
      const used = usage.total.get(row.id) ?? 0;
      const mine = usage.mine.get(row.id) ?? 0;
      if (row.maxRedemptions !== null && used >= row.maxRedemptions) {
        blocked.set(row.id, 'EXHAUSTED');
      } else if (row.maxPerUser !== null && mine >= row.maxPerUser) {
        blocked.set(row.id, 'ALREADY_USED');
      } else {
        eligible.push(toCandidate(row));
      }
    }
    const discount = chooseBest(eligible, ctx);

    let couponView: QuoteCouponDto | null = null;
    let couponId: string | null = null;
    if (code) {
      const reason = this.couponRejection(coupon, rows, eligible, blocked, ctx);
      if (reason) {
        couponView = { code, applied: false, reason };
      } else {
        const applied = discount?.promotion.id === coupon!.promotionId;
        couponView = { code, applied, reason: applied ? null : 'BETTER_PROMOTION' };
        if (applied) couponId = coupon!.id;
      }
    }
    return { discount, couponId, coupon: couponView };
  }

  private couponRejection(
    coupon: {
      id: string;
      promotionId: string;
      promotion: { scope: string; scopeId: string | null };
    } | null,
    rows: { id: string }[],
    eligible: PromotionCandidate[],
    blocked: Map<string, CouponRejection>,
    ctx: BookingContext,
  ): CouponRejection | null {
    if (!coupon) return 'NOT_FOUND';
    if (!rows.some((r) => r.id === coupon.promotionId)) {
      // No es candidata: o no está vigente, o es de otra barbería o servicio ("no aplica").
      const { scope, scopeId } = coupon.promotion;
      const covers =
        scope === 'PLATFORM' ||
        (scope === 'BARBERSHOP' && scopeId === ctx.barbershopId) ||
        (scope === 'SERVICE' && scopeId === ctx.serviceId);
      return covers ? 'NOT_ACTIVE' : 'NOT_APPLICABLE';
    }
    const blockedReason = blocked.get(coupon.promotionId);
    if (blockedReason) return blockedReason;
    const promotion = eligible.find((p) => p.id === coupon.promotionId)!;
    if (!appliesTo(promotion, ctx) || discountAmount(promotion, ctx.subtotal) <= 0) {
      return 'NOT_APPLICABLE';
    }
    return null;
  }

  /** Registra el canje en la transacción de la reserva. */
  async recordRedemption(
    tx: Prisma.TransactionClient,
    input: {
      bookingId: string;
      userId: string;
      discount: ChosenDiscount;
      couponId: string | null;
      currency: string;
    },
  ): Promise<void> {
    await tx.promotionRedemption.create({
      data: {
        promotionId: input.discount.promotion.id,
        couponId: input.couponId,
        userId: input.userId,
        bookingId: input.bookingId,
        discountAmount: input.discount.amount,
        currency: input.currency,
        fundedBy: input.discount.funder,
      },
    });
  }

  private async usage(
    db: Db,
    ids: string[],
    clientId: string | null,
  ): Promise<{ total: Map<string, number>; mine: Map<string, number> }> {
    if (ids.length === 0) return { total: new Map(), mine: new Map() };
    const [total, mine] = await Promise.all([
      db.promotionRedemption.groupBy({
        by: ['promotionId'],
        where: { promotionId: { in: ids }, releasedAt: null },
        _count: { _all: true },
      }),
      clientId
        ? db.promotionRedemption.groupBy({
            by: ['promotionId'],
            where: { promotionId: { in: ids }, releasedAt: null, userId: clientId },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    return {
      total: new Map(total.map((t) => [t.promotionId, t._count._all])),
      mine: new Map(mine.map((t) => [t.promotionId, t._count._all])),
    };
  }

  // ───────────── Vista pública ─────────────

  /** Promociones automáticas vigentes de una barbería visible (y las de Charles). */
  async activeForBarbershop(barbershopId: string): Promise<PublicPromotionDto[]> {
    await this.access.requirePublic(barbershopId);
    const now = new Date(this.clock.now());
    const rows = await this.prisma.promotion.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        requiresCoupon: false,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        AND: [{ OR: [{ scope: 'PLATFORM' }, { barbershopId }] }],
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    const usage = await this.usage(
      this.prisma,
      rows.map((r) => r.id),
      null,
    );
    return rows
      .filter((r) => r.maxRedemptions === null || (usage.total.get(r.id) ?? 0) < r.maxRedemptions)
      .map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        value: r.value,
        currency: r.currency,
        serviceId: r.scope === 'SERVICE' ? r.scopeId : null,
        daysOfWeek: parseRules(r.rules).daysOfWeek ?? [],
        endsAt: r.endsAt,
        fromCharles: r.scope === 'PLATFORM',
      }));
  }

  // ───────────── Administración por la barbería (OWNER o MANAGER) ─────────────

  async listForBarbershop(userId: string, barbershopId: string): Promise<PromotionDto[]> {
    await this.access.requireMember(userId, barbershopId);
    return this.list({ barbershopId });
  }

  async createForBarbershop(
    actor: Actor,
    barbershopId: string,
    dto: CreatePromotionDto,
  ): Promise<PromotionDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    if (dto.serviceId) {
      const owned = await this.prisma.service.count({
        where: { id: dto.serviceId, barbershopId, deletedAt: null },
      });
      if (!owned) throw invalid('serviceId', 'serviceOfBarbershop');
    }
    return this.create(actor, dto, {
      scope: dto.serviceId ? 'SERVICE' : 'BARBERSHOP',
      scopeId: dto.serviceId ?? barbershopId,
      barbershopId,
    });
  }

  async updateForBarbershop(
    actor: Actor,
    barbershopId: string,
    promotionId: string,
    dto: UpdatePromotionDto,
  ): Promise<PromotionDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    await this.requireOwned(promotionId, barbershopId);
    return this.update(actor, promotionId, dto);
  }

  async addCouponForBarbershop(
    actor: Actor,
    barbershopId: string,
    promotionId: string,
    dto: CreateCouponDto,
  ): Promise<PromotionDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    await this.requireOwned(promotionId, barbershopId);
    return this.addCoupon(actor, promotionId, dto);
  }

  async removeCouponForBarbershop(
    actor: Actor,
    barbershopId: string,
    promotionId: string,
    couponId: string,
  ): Promise<PromotionDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    await this.requireOwned(promotionId, barbershopId);
    return this.removeCoupon(actor, promotionId, couponId);
  }

  private async requireOwned(promotionId: string, barbershopId: string): Promise<void> {
    const found = await this.prisma.promotion.count({
      where: { id: promotionId, barbershopId, deletedAt: null },
    });
    if (!found) throw notFound();
  }

  // ───────────── Administración de Charles (ADMIN) ─────────────

  adminList(filter: {
    scope?: 'PLATFORM' | 'BARBERSHOP' | 'SERVICE';
    barbershopId?: string;
  }): Promise<PromotionDto[]> {
    return this.list(filter);
  }

  async createPlatform(actor: Actor, dto: CreatePromotionDto): Promise<PromotionDto> {
    if (dto.serviceId) throw invalid('serviceId', 'notAllowedForPlatform');
    return this.create(actor, dto, { scope: 'PLATFORM', scopeId: null, barbershopId: null });
  }

  async adminUpdate(
    actor: Actor,
    promotionId: string,
    dto: UpdatePromotionDto,
  ): Promise<PromotionDto> {
    await this.requireExists(promotionId);
    return this.update(actor, promotionId, dto);
  }

  async adminAddCoupon(
    actor: Actor,
    promotionId: string,
    dto: CreateCouponDto,
  ): Promise<PromotionDto> {
    await this.requireExists(promotionId);
    return this.addCoupon(actor, promotionId, dto);
  }

  async adminRemoveCoupon(
    actor: Actor,
    promotionId: string,
    couponId: string,
  ): Promise<PromotionDto> {
    await this.requireExists(promotionId);
    return this.removeCoupon(actor, promotionId, couponId);
  }

  private async requireExists(promotionId: string): Promise<void> {
    const found = await this.prisma.promotion.count({
      where: { id: promotionId, deletedAt: null },
    });
    if (!found) throw notFound();
  }

  // ───────────── Común ─────────────

  private async create(
    actor: Actor,
    dto: CreatePromotionDto,
    target: {
      scope: 'PLATFORM' | 'BARBERSHOP' | 'SERVICE';
      scopeId: string | null;
      barbershopId: string | null;
    },
  ): Promise<PromotionDto> {
    if (
      dto.type === 'FIXED_AMOUNT' &&
      (dto.value < FIXED_AMOUNT_LIMITS.min || dto.value > FIXED_AMOUNT_LIMITS.max)
    ) {
      throw invalid('value', 'fixedAmountRange');
    }
    const startsAt = dto.startsAt ?? new Date(this.clock.now());
    if (dto.endsAt && dto.endsAt <= startsAt) throw invalid('endsAt', 'afterStartsAt');
    const days = [...new Set(dto.daysOfWeek ?? [])].sort();
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.promotion.create({
        data: {
          scope: target.scope,
          scopeId: target.scopeId,
          barbershopId: target.barbershopId,
          name: dto.name,
          type: dto.type,
          value: dto.value,
          currency: dto.type === 'FIXED_AMOUNT' ? PROMOTION_CURRENCY : null,
          startsAt,
          endsAt: dto.endsAt ?? null,
          maxRedemptions: dto.maxRedemptions ?? null,
          maxPerUser: dto.maxPerUser ?? null,
          rules: days.length > 0 ? { daysOfWeek: days } : {},
          requiresCoupon: dto.requiresCoupon ?? false,
          createdById: actor.userId,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'promotion.created',
          entityType: 'promotion',
          entityId: created.id,
          changes: { scope: target.scope, type: dto.type, value: dto.value },
          ip: actor.ip ?? null,
        },
        tx,
      );
      return created.id;
    });
    return this.one(id);
  }

  private async update(
    actor: Actor,
    promotionId: string,
    dto: UpdatePromotionDto,
  ): Promise<PromotionDto> {
    const current = await this.prisma.promotion.findUniqueOrThrow({
      where: { id: promotionId },
      select: { startsAt: true },
    });
    if (dto.endsAt && dto.endsAt <= current.startsAt) throw invalid('endsAt', 'afterStartsAt');
    const data: Prisma.PromotionUpdateInput = {};
    const fields: string[] = [];
    for (const key of ['name', 'endsAt', 'maxRedemptions', 'maxPerUser', 'isActive'] as const) {
      if (dto[key] !== undefined) {
        (data as Record<string, unknown>)[key] = dto[key];
        fields.push(key);
      }
    }
    if (fields.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.promotion.update({ where: { id: promotionId }, data });
        await this.audit.record(
          {
            actorId: actor.userId,
            action: 'promotion.updated',
            entityType: 'promotion',
            entityId: promotionId,
            changes: { fields, ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) },
            ip: actor.ip ?? null,
          },
          tx,
        );
      });
    }
    return this.one(promotionId);
  }

  private async addCoupon(
    actor: Actor,
    promotionId: string,
    dto: CreateCouponDto,
  ): Promise<PromotionDto> {
    const count = await this.prisma.coupon.count({ where: { promotionId, deletedAt: null } });
    if (count >= MAX_COUPONS_PER_PROMOTION) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `Una promoción tiene como máximo ${MAX_COUPONS_PER_PROMOTION} cupones.`,
        HttpStatus.CONFLICT,
      );
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const coupon = await tx.coupon.create({
          data: { promotionId, code: dto.code },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorId: actor.userId,
            action: 'promotion.coupon_created',
            entityType: 'promotion',
            entityId: promotionId,
            changes: { couponId: coupon.id },
            ip: actor.ip ?? null,
          },
          tx,
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.COUPON_CODE_TAKEN,
          'Ese código de cupón ya existe. Elige otro.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
    return this.one(promotionId);
  }

  /** Retira un cupón: deja de aceptarse; los canjes hechos se conservan. */
  private async removeCoupon(
    actor: Actor,
    promotionId: string,
    couponId: string,
  ): Promise<PromotionDto> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.coupon.updateMany({
        where: { id: couponId, promotionId, deletedAt: null },
        data: { deletedAt: new Date(this.clock.now()) },
      });
      if (count === 0) {
        throw new AppException(ErrorCode.NOT_FOUND, 'El cupón no existe.', HttpStatus.NOT_FOUND);
      }
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'promotion.coupon_removed',
          entityType: 'promotion',
          entityId: promotionId,
          changes: { couponId },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    return this.one(promotionId);
  }

  private async one(id: string): Promise<PromotionDto> {
    const [dto] = await this.list({ id });
    if (!dto) throw notFound();
    return dto;
  }

  private async list(filter: {
    id?: string;
    barbershopId?: string;
    scope?: 'PLATFORM' | 'BARBERSHOP' | 'SERVICE';
  }): Promise<PromotionDto[]> {
    const rows = await this.prisma.promotion.findMany({
      where: {
        deletedAt: null,
        ...(filter.id ? { id: filter.id } : {}),
        ...(filter.barbershopId ? { barbershopId: filter.barbershopId } : {}),
        ...(filter.scope ? { scope: filter.scope } : {}),
      },
      include: {
        coupons: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const ids = rows.map((r) => r.id);
    const [byPromotion, byCoupon] = await Promise.all([
      this.prisma.promotionRedemption.groupBy({
        by: ['promotionId'],
        where: { promotionId: { in: ids }, releasedAt: null },
        _count: { _all: true },
        _sum: { discountAmount: true },
      }),
      this.prisma.promotionRedemption.groupBy({
        by: ['couponId'],
        where: { promotionId: { in: ids }, releasedAt: null, couponId: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const stats = new Map(byPromotion.map((s) => [s.promotionId, s]));
    const couponUses = new Map(byCoupon.map((c) => [c.couponId, c._count._all]));
    const now = this.clock.now();
    return rows.map((r) => {
      const redemptions = stats.get(r.id)?._count._all ?? 0;
      return {
        id: r.id,
        scope: r.scope,
        barbershopId: r.barbershopId,
        serviceId: r.scope === 'SERVICE' ? r.scopeId : null,
        name: r.name,
        type: r.type,
        value: r.value,
        currency: r.currency,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        maxRedemptions: r.maxRedemptions,
        maxPerUser: r.maxPerUser,
        daysOfWeek: parseRules(r.rules).daysOfWeek ?? [],
        requiresCoupon: r.requiresCoupon,
        isActive: r.isActive,
        status: !r.isActive
          ? 'PAUSED'
          : r.startsAt.getTime() > now
            ? 'SCHEDULED'
            : r.endsAt && r.endsAt.getTime() <= now
              ? 'ENDED'
              : r.maxRedemptions !== null && redemptions >= r.maxRedemptions
                ? 'EXHAUSTED'
                : 'ACTIVE',
        redemptions,
        discountedTotal: {
          amount: stats.get(r.id)?._sum.discountAmount ?? 0,
          currency: PROMOTION_CURRENCY,
        },
        coupons: r.coupons.map((c) => ({
          id: c.id,
          code: c.code,
          redemptions: couponUses.get(c.id) ?? 0,
          createdAt: c.createdAt,
        })),
        createdAt: r.createdAt,
      };
    });
  }
}

function toCandidate(row: {
  id: string;
  name: string;
  scope: 'PLATFORM' | 'BARBERSHOP' | 'SERVICE';
  scopeId: string | null;
  type: 'PERCENTAGE' | 'FIXED_AMOUNT';
  value: number;
  currency: string | null;
  rules: Prisma.JsonValue;
}): PromotionCandidate {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    scopeId: row.scopeId,
    type: row.type,
    value: row.value,
    currency: row.currency,
    rules: parseRules(row.rules),
  };
}
