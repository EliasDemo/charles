import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { ClientTier } from '../../generated/prisma/enums';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { DAY_MS } from '../billing/billing-gateway';
import { EntitlementsService } from '../plans/entitlements.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import type {
  ClientVisitDto,
  CreateShopClientDto,
  RankingDto,
  ShopClientDetailDto,
  ShopClientDto,
  ShopClientsQueryDto,
  UpdateShopClientDto,
} from './dto/shop.dto';

export const RANKING_DEFAULTS = { gold: 100, silver: 50, bronze: 10, windowDays: 180 };

const clientInclude = { user: { select: { username: true } } } satisfies Prisma.ShopClientInclude;
type ClientRow = Prisma.ShopClientGetPayload<{ include: typeof clientInclude }>;

export const shopClientNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El cliente no existe.', HttpStatus.NOT_FOUND);

/**
 * Puntaje del ranking: frecuencia, gasto y antigüedad en la ventana configurada.
 * 10 puntos por visita, 1 por cada S/ 10 gastados y 1 por mes desde la primera visita (hasta 24).
 */
export function rankingScore(input: {
  visits: number;
  spent: number;
  firstVisitAt: Date | null;
  now: number;
}): number {
  const months = input.firstVisitAt
    ? Math.min(24, Math.floor((input.now - input.firstVisitAt.getTime()) / (30 * DAY_MS)))
    : 0;
  return input.visits * 10 + Math.floor(input.spent / 1000) + Math.max(0, months);
}

export function tierFor(
  score: number,
  t: { gold: number; silver: number; bronze: number },
): ClientTier {
  if (score >= t.gold) return 'GOLD';
  if (score >= t.silver) return 'SILVER';
  if (score >= t.bronze) return 'BRONZE';
  return 'NONE';
}

/**
 * Panel de la barbería: clientes (con cuenta en la app o registrados en el local), su historial y
 * el ranking de clientes habituales (Bronce, Plata y Oro) que usan las promociones por nivel.
 * Los datos de un cliente los ve solo esa barbería (OWNER y MANAGER).
 */
@Injectable()
export class ShopClientsService {
  private readonly logger = new Logger(ShopClientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly users: UsersService,
    private readonly entitlements: EntitlementsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(
    userId: string,
    barbershopId: string,
    query: ShopClientsQueryDto,
  ): Promise<ShopClientDto[]> {
    await this.access.requireMember(userId, barbershopId);
    const q = query.q?.trim();
    const rows = await this.prisma.shopClient.findMany({
      where: {
        barbershopId,
        archivedAt: null,
        ...(query.tier ? { tier: query.tier } : {}),
        ...(query.regular !== undefined ? { isRegular: query.regular } : {}),
        ...(q
          ? {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                { user: { username: { contains: q.toLowerCase() } } },
              ],
            }
          : {}),
      },
      include: clientInclude,
      orderBy:
        query.sort === 'score'
          ? [{ score: 'desc' }, { id: 'asc' }]
          : query.sort === 'name'
            ? [{ displayName: 'asc' }, { id: 'asc' }]
            : [{ lastVisitAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map((r) => this.toDto(r));
  }

  async detail(
    userId: string,
    barbershopId: string,
    clientId: string,
  ): Promise<ShopClientDetailDto> {
    await this.access.requireMember(userId, barbershopId);
    const client = await this.find(barbershopId, clientId);
    const [bookings, sales] = await Promise.all([
      client.userId
        ? this.prisma.booking.findMany({
            where: { barbershopId, clientId: client.userId, status: 'ATTENDED' },
            select: {
              id: true,
              startAt: true,
              serviceNameSnapshot: true,
              subtotalAmount: true,
              discountTotalAmount: true,
              barber: { select: { displayName: true } },
            },
            orderBy: { startAt: 'desc' },
            take: 30,
          })
        : [],
      this.prisma.localSale.findMany({
        where: { barbershopId, shopClientId: client.id, status: 'COMPLETED' },
        select: {
          id: true,
          soldAt: true,
          totalAmount: true,
          barber: { select: { displayName: true } },
          lines: { select: { description: true } },
        },
        orderBy: { soldAt: 'desc' },
        take: 30,
      }),
    ]);
    const visits: ClientVisitDto[] = [
      ...bookings.map((b) => ({
        source: 'BOOKING' as const,
        id: b.id,
        at: b.startAt,
        services: [b.serviceNameSnapshot],
        barberName: b.barber.displayName,
        totalAmount: b.subtotalAmount - b.discountTotalAmount,
      })),
      ...sales.map((s) => ({
        source: 'SALE' as const,
        id: s.id,
        at: s.soldAt,
        services: s.lines.map((l) => l.description),
        barberName: s.barber?.displayName ?? null,
        totalAmount: s.totalAmount,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 30);
    return { ...this.toDto(client), visits };
  }

  async create(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    dto: CreateShopClientDto,
  ): Promise<ShopClientDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    let linkedUserId: string | null = null;
    let displayName = dto.displayName ?? null;
    if (dto.username) {
      const user = await this.users.findCredentialsByUsername(dto.username);
      if (!user || user.isDeleted) {
        throw new AppException(ErrorCode.NOT_FOUND, 'Ese usuario no existe.', HttpStatus.NOT_FOUND);
      }
      linkedUserId = user.id;
      displayName ??= (await this.firstNames([user.id])).get(user.id) ?? dto.username;
    }
    if (!displayName) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'displayName', constraints: ['isNotEmpty'] }],
      );
    }
    const used = await this.prisma.shopClient.count({ where: { barbershopId, archivedAt: null } });
    await this.entitlements.assertWithin(barbershopId, 'crm_clients', used);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.shopClient.create({
          data: {
            barbershopId,
            userId: linkedUserId,
            displayName,
            phoneEnc: this.encryption.encryptNullable(
              dto.phone ?? null,
              EncryptedField.SHOP_CLIENT_PHONE,
            ),
            notes: dto.notes || null,
            preferences: dto.preferences || null,
            isRegular: dto.isRegular ?? false,
          },
          include: clientInclude,
        });
        await this.audit.record(
          {
            actorId: actor.userId,
            action: 'shop_client.created',
            entityType: 'shop_client',
            entityId: row.id,
            changes: { barbershopId, linked: linkedUserId !== null },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return row;
      });
      return this.toDto(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Ese cliente ya está registrado.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async update(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    clientId: string,
    dto: UpdateShopClientDto,
  ): Promise<ShopClientDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    const client = await this.find(barbershopId, clientId);
    if (dto.archived === false && client.archivedAt) {
      const used = await this.prisma.shopClient.count({
        where: { barbershopId, archivedAt: null },
      });
      await this.entitlements.assertWithin(barbershopId, 'crm_clients', used);
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.shopClient.update({
        where: { id: clientId },
        data: {
          displayName: dto.displayName,
          phoneEnc:
            dto.phone === undefined
              ? undefined
              : this.encryption.encryptNullable(dto.phone, EncryptedField.SHOP_CLIENT_PHONE),
          notes: dto.notes,
          preferences: dto.preferences,
          isRegular: dto.isRegular,
          archivedAt:
            dto.archived === undefined
              ? undefined
              : dto.archived
                ? new Date(this.clock.now())
                : null,
        },
        include: clientInclude,
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'shop_client.updated',
          entityType: 'shop_client',
          entityId: clientId,
          changes: { fields: Object.keys(dto).filter((k) => k !== 'phone' && k !== 'notes') },
          ip: actor.ip ?? null,
        },
        tx,
      );
      return updated;
    });
    return this.toDto(row);
  }

  /** Busca o crea el cliente de una persona de la app (al venderle en el local). */
  async ensureForUser(barbershopId: string, userId: string): Promise<string> {
    const existing = await this.prisma.shopClient.findUnique({
      where: { barbershopId_userId: { barbershopId, userId } },
      select: { id: true },
    });
    if (existing) return existing.id;
    const name = (await this.firstNames([userId])).get(userId) ?? 'Cliente';
    const row = await this.prisma.shopClient.upsert({
      where: { barbershopId_userId: { barbershopId, userId } },
      create: { barbershopId, userId, displayName: name },
      update: {},
      select: { id: true },
    });
    return row.id;
  }

  // ───────────── Ranking ─────────────

  async ranking(userId: string, barbershopId: string): Promise<RankingDto> {
    await this.access.requireMember(userId, barbershopId);
    await this.entitlements.assertFeature(barbershopId, 'client_ranking');
    const t = await this.thresholds();
    const [counts, top, last] = await Promise.all([
      this.prisma.shopClient.groupBy({
        by: ['tier'],
        where: { barbershopId, archivedAt: null },
        _count: { _all: true },
      }),
      this.prisma.shopClient.findMany({
        where: { barbershopId, archivedAt: null, tier: { not: 'NONE' } },
        include: clientInclude,
        orderBy: [{ score: 'desc' }, { id: 'asc' }],
        take: 50,
      }),
      this.prisma.shopClient.findFirst({
        where: { barbershopId, rankedAt: { not: null } },
        orderBy: { rankedAt: 'desc' },
        select: { rankedAt: true },
      }),
    ]);
    const countOf = (tier: ClientTier) => counts.find((c) => c.tier === tier)?._count._all ?? 0;
    return {
      tiers: [
        { tier: 'GOLD', count: countOf('GOLD'), minScore: t.gold },
        { tier: 'SILVER', count: countOf('SILVER'), minScore: t.silver },
        { tier: 'BRONZE', count: countOf('BRONZE'), minScore: t.bronze },
        { tier: 'NONE', count: countOf('NONE'), minScore: null },
      ],
      top: top.map((r) => this.toDto(r)),
      windowDays: t.windowDays,
      rankedAt: last?.rankedAt ?? null,
    };
  }

  async recomputeFor(userId: string, barbershopId: string): Promise<RankingDto> {
    await this.access.requireMember(userId, barbershopId);
    await this.entitlements.assertFeature(barbershopId, 'client_ranking');
    await this.recompute(barbershopId);
    return this.ranking(userId, barbershopId);
  }

  /**
   * Recalcula el ranking de una barbería: suma las reservas atendidas y las ventas del local de la
   * ventana, registra como clientes a quienes reservaron por la app y asigna el nivel.
   */
  async recompute(barbershopId: string): Promise<number> {
    const now = this.clock.now();
    const t = await this.thresholds();
    const since = new Date(now - t.windowDays * DAY_MS);

    const attended = await this.prisma.booking.groupBy({
      by: ['clientId'],
      where: { barbershopId, status: 'ATTENDED' },
      _min: { startAt: true },
      _max: { startAt: true },
    });
    const missing = attended.map((a) => a.clientId);
    if (missing.length > 0) {
      const names = await this.firstNames(missing);
      await this.prisma.shopClient.createMany({
        data: missing.map((id) => ({
          barbershopId,
          userId: id,
          displayName: names.get(id) ?? 'Cliente',
        })),
        skipDuplicates: true,
      });
    }
    const [recentBookings, sales, salesAll, clients] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['clientId'],
        where: { barbershopId, status: 'ATTENDED', startAt: { gte: since } },
        _count: { _all: true },
        _sum: { subtotalAmount: true, discountTotalAmount: true },
      }),
      this.prisma.localSale.groupBy({
        by: ['shopClientId'],
        where: {
          barbershopId,
          status: 'COMPLETED',
          soldAt: { gte: since },
          shopClientId: { not: null },
        },
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      this.prisma.localSale.groupBy({
        by: ['shopClientId'],
        where: { barbershopId, status: 'COMPLETED', shopClientId: { not: null } },
        _min: { soldAt: true },
        _max: { soldAt: true },
      }),
      this.prisma.shopClient.findMany({
        where: { barbershopId },
        select: { id: true, userId: true },
      }),
    ]);
    const byUser = new Map(recentBookings.map((b) => [b.clientId, b]));
    const allByUser = new Map(attended.map((a) => [a.clientId, a]));
    const bySale = new Map(sales.map((s) => [s.shopClientId!, s]));
    const allBySale = new Map(salesAll.map((s) => [s.shopClientId!, s]));

    const ops = clients.map((c) => {
      const b = c.userId ? byUser.get(c.userId) : undefined;
      const ba = c.userId ? allByUser.get(c.userId) : undefined;
      const s = bySale.get(c.id);
      const sa = allBySale.get(c.id);
      const visits = (b?._count._all ?? 0) + (s?._count._all ?? 0);
      const spent =
        (b?._sum.subtotalAmount ?? 0) -
        (b?._sum.discountTotalAmount ?? 0) +
        (s?._sum.totalAmount ?? 0);
      const firsts = [ba?._min.startAt, sa?._min.soldAt].filter(
        (d): d is Date => d instanceof Date,
      );
      const lasts = [ba?._max.startAt, sa?._max.soldAt].filter((d): d is Date => d instanceof Date);
      const firstVisitAt = firsts.length
        ? new Date(Math.min(...firsts.map((d) => d.getTime())))
        : null;
      const lastVisitAt = lasts.length
        ? new Date(Math.max(...lasts.map((d) => d.getTime())))
        : null;
      const score = rankingScore({ visits, spent, firstVisitAt, now });
      return this.prisma.shopClient.update({
        where: { id: c.id },
        data: {
          visitsCount: visits,
          totalSpent: Math.max(0, spent),
          firstVisitAt,
          lastVisitAt,
          score,
          tier: tierFor(score, t),
          rankedAt: new Date(now),
        },
      });
    });
    for (let i = 0; i < ops.length; i += 200) {
      await this.prisma.$transaction(ops.slice(i, i + 200));
    }
    return clients.length;
  }

  /** Trabajo nocturno: todas las barberías con clientes o reservas atendidas. */
  async recomputeAll(): Promise<number> {
    const shops = await this.prisma.barbershop.findMany({
      where: {
        deletedAt: null,
        OR: [{ shopClients: { some: {} } }, { bookings: { some: { status: 'ATTENDED' } } }],
      },
      select: { id: true },
    });
    for (const shop of shops) {
      try {
        await this.recompute(shop.id);
      } catch (error) {
        this.logger.warn(`Ranking de ${shop.id} falló: ${(error as Error).message}`);
      }
    }
    return shops.length;
  }

  // ───────────── Apoyo ─────────────

  async find(barbershopId: string, clientId: string): Promise<ClientRow> {
    const row = await this.prisma.shopClient.findFirst({
      where: { id: clientId, barbershopId },
      include: clientInclude,
    });
    if (!row) throw shopClientNotFound();
    return row;
  }

  private async thresholds(): Promise<{
    gold: number;
    silver: number;
    bronze: number;
    windowDays: number;
  }> {
    const [gold, silver, bronze, windowDays] = await Promise.all([
      this.settings.positiveInt(SettingKey.RANKING_GOLD_MIN, RANKING_DEFAULTS.gold),
      this.settings.positiveInt(SettingKey.RANKING_SILVER_MIN, RANKING_DEFAULTS.silver),
      this.settings.positiveInt(SettingKey.RANKING_BRONZE_MIN, RANKING_DEFAULTS.bronze),
      this.settings.positiveInt(SettingKey.RANKING_WINDOW_DAYS, RANKING_DEFAULTS.windowDays),
    ]);
    return { gold, silver, bronze, windowDays };
  }

  /** Nombre de pila de cuentas de la app (la barbería no ve el nombre completo en la lista). */
  private async firstNames(ids: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, r.fullName.trim().split(/\s+/)[0] ?? r.fullName]));
  }

  toDto(r: ClientRow): ShopClientDto {
    return {
      id: r.id,
      displayName: r.displayName,
      username: r.user?.username ?? null,
      phone: this.encryption.decryptNullable(r.phoneEnc, EncryptedField.SHOP_CLIENT_PHONE),
      notes: r.notes,
      preferences: r.preferences,
      isRegular: r.isRegular,
      tier: r.tier,
      score: r.score,
      visitsCount: r.visitsCount,
      totalSpent: r.totalSpent,
      firstVisitAt: r.firstVisitAt,
      lastVisitAt: r.lastVisitAt,
      createdAt: r.createdAt,
    };
  }
}
