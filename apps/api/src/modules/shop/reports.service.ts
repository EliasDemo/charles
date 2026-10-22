import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { DAY_MS } from '../billing/billing-gateway';
import { EntitlementsService } from '../plans/entitlements.service';
import type {
  BarberCommissionDto,
  HeatmapCellDto,
  HeatmapDto,
  MarketDto,
  MonthlyReportDto,
  MonthReportDto,
  ReportBarberDto,
  ReportsQueryDto,
  SalesReportDto,
  ServiceTrendDto,
} from './dto/shop.dto';
import { locationOf } from '../locations/locations';

const MAX_RANGE_DAYS = 366;

/** Día de Lima (YYYY-MM-DD) de un instante. */
const limaDay = (d: Date): string =>
  new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Caja y reportes de la barbería: lo atendido por la app (reservas ATTENDED, a precio con
 * descuento) más lo vendido en el local (ventas no anuladas). Por barbero (con su comisión) y por
 * servicio solo con "reportes completos"; exportar a CSV con "exportar reportes".
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly entitlements: EntitlementsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async sales(
    userId: string,
    barbershopId: string,
    query: ReportsQueryDto,
  ): Promise<SalesReportDto> {
    await this.access.requireMember(userId, barbershopId);
    const { from, to } = query;
    if (to <= from || to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'to', constraints: ['rangeUpTo366Days'] }],
      );
    }
    const full = await this.entitlements.has(barbershopId, 'reports_full');
    const [bookings, sales] = await Promise.all([
      this.prisma.booking.findMany({
        where: { barbershopId, status: 'ATTENDED', startAt: { gte: from, lt: to } },
        select: {
          startAt: true,
          clientId: true,
          barberId: true,
          serviceNameSnapshot: true,
          subtotalAmount: true,
          discountTotalAmount: true,
        },
      }),
      this.prisma.localSale.findMany({
        where: { barbershopId, status: 'COMPLETED', soldAt: { gte: from, lt: to } },
        select: {
          soldAt: true,
          shopClientId: true,
          barberId: true,
          totalAmount: true,
          paymentMethod: true,
          shopClient: { select: { userId: true } },
          lines: { select: { description: true, quantity: true, totalAmount: true } },
        },
      }),
    ]);

    const byDay = new Map<string, { appAmount: number; localAmount: number; count: number }>();
    const day = (d: Date) => {
      const key = limaDay(d);
      const row = byDay.get(key) ?? { appAmount: 0, localAmount: 0, count: 0 };
      byDay.set(key, row);
      return row;
    };
    const byBarber = new Map<string, { count: number; amount: number }>();
    const byService = new Map<string, { count: number; amount: number }>();
    const byMethod = new Map<string, { count: number; amount: number }>();
    const add = <K>(
      m: Map<K, { count: number; amount: number }>,
      k: K,
      amount: number,
      count = 1,
    ) => {
      const row = m.get(k) ?? { count: 0, amount: 0 };
      row.count += count;
      row.amount += amount;
      m.set(k, row);
    };

    let appAmount = 0;
    for (const b of bookings) {
      const amount = b.subtotalAmount - b.discountTotalAmount;
      appAmount += amount;
      const d = day(b.startAt);
      d.appAmount += amount;
      d.count++;
      add(byBarber, b.barberId, amount);
      add(byService, b.serviceNameSnapshot, amount);
    }
    let localAmount = 0;
    for (const s of sales) {
      // Lo pagado con crédito de membresía ya se cobró con la membresía: no suma a la caja.
      const amount = s.paymentMethod === 'MEMBERSHIP_CREDIT' ? 0 : s.totalAmount;
      localAmount += amount;
      const d = day(s.soldAt);
      d.localAmount += amount;
      d.count++;
      add(byMethod, s.paymentMethod, amount);
      if (s.barberId) add(byBarber, s.barberId, amount);
      for (const l of s.lines) add(byService, l.description, l.totalAmount, l.quantity);
    }
    const count = bookings.length + sales.length;
    const total = appAmount + localAmount;

    // Clientes nuevos (primera visita en el periodo) frente a recurrentes.
    const userIds = new Set<string>([
      ...bookings.map((b) => b.clientId),
      ...sales.map((s) => s.shopClient?.userId).filter((id): id is string => !!id),
    ]);
    const walkIns = new Set(
      sales.filter((s) => s.shopClientId && !s.shopClient?.userId).map((s) => s.shopClientId!),
    );
    const [priorBookings, priorSales] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          barbershopId,
          status: 'ATTENDED',
          startAt: { lt: from },
          clientId: { in: [...userIds] },
        },
        distinct: ['clientId'],
        select: { clientId: true },
      }),
      this.prisma.localSale.findMany({
        where: {
          barbershopId,
          status: 'COMPLETED',
          soldAt: { lt: from },
          OR: [
            { shopClientId: { in: [...walkIns] } },
            { shopClient: { userId: { in: [...userIds] } } },
          ],
        },
        distinct: ['shopClientId'],
        select: { shopClientId: true, shopClient: { select: { userId: true } } },
      }),
    ]);
    const returningKeys = new Set<string>([
      ...priorBookings.map((b) => `u:${b.clientId}`),
      ...priorSales.map((s) =>
        s.shopClient?.userId ? `u:${s.shopClient.userId}` : `c:${s.shopClientId}`,
      ),
    ]);
    const allKeys = new Set<string>([
      ...[...userIds].map((u) => `u:${u}`),
      ...[...walkIns].map((c) => `c:${c}`),
    ]);
    const returning = [...allKeys].filter((k) => returningKeys.has(k)).length;

    let barbers: ReportBarberDto[] = [];
    if (full && byBarber.size > 0) {
      const rows = await this.prisma.barber.findMany({
        where: { id: { in: [...byBarber.keys()] } },
        select: { id: true, displayName: true, commissionBp: true },
      });
      barbers = rows
        .map((b) => {
          const agg = byBarber.get(b.id)!;
          return {
            barberId: b.id,
            barberName: b.displayName,
            count: agg.count,
            amount: agg.amount,
            commissionBp: b.commissionBp,
            commissionAmount: b.commissionBp
              ? Math.round((agg.amount * b.commissionBp) / 10_000)
              : 0,
          };
        })
        .sort((a, b) => b.amount - a.amount);
    }

    return {
      from,
      to,
      appAmount,
      localAmount,
      totalAmount: total,
      count,
      averageTicket: count ? Math.round(total / count) : 0,
      newClients: allKeys.size - returning,
      returningClients: returning,
      byDay: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, v]) => ({ day: d, ...v })),
      byBarber: barbers,
      byService: full
        ? [...byService.entries()]
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.amount - a.amount)
        : [],
      byMethod: [...byMethod.entries()].map(([method, v]) => ({
        method: method as SalesReportDto['byMethod'][number]['method'],
        ...v,
      })),
      full,
    };
  }

  // ───────────── Por mes, mapa de horas y mercado ─────────────

  /** Ventas por mes (app + local), crecimiento, mejor y peor mes, y servicios que suben o bajan. */
  async monthly(userId: string, barbershopId: string, months = 12): Promise<MonthlyReportDto> {
    await this.access.requireMember(userId, barbershopId);
    const now = this.clock.now();
    const keyOf = (d: Date) => new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 7);
    const current = new Date(now - 5 * 3_600_000);
    const keys: string[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - i, 1));
      keys.push(d.toISOString().slice(0, 7));
    }
    const yearAgoKey = (() => {
      const d = new Date(Date.UTC(current.getUTCFullYear() - 1, current.getUTCMonth(), 1));
      return d.toISOString().slice(0, 7);
    })();
    const from = new Date(
      Date.UTC(Number(keys[0]!.slice(0, 4)), Number(keys[0]!.slice(5)) - 1, 1, 5),
    );
    const yearAgoFrom = new Date(
      Date.UTC(current.getUTCFullYear() - 1, current.getUTCMonth(), 1, 5),
    );
    const since = from < yearAgoFrom ? from : yearAgoFrom;
    const [bookings, sales] = await Promise.all([
      this.prisma.booking.findMany({
        where: { barbershopId, status: 'ATTENDED', startAt: { gte: since } },
        select: {
          startAt: true,
          clientId: true,
          subtotalAmount: true,
          discountTotalAmount: true,
          serviceNameSnapshot: true,
        },
      }),
      this.prisma.localSale.findMany({
        where: { barbershopId, status: 'COMPLETED', soldAt: { gte: since } },
        select: {
          soldAt: true,
          totalAmount: true,
          paymentMethod: true,
          shopClientId: true,
          shopClient: { select: { userId: true } },
          lines: { select: { description: true, quantity: true } },
        },
      }),
    ]);
    // Primera visita de cada cliente (toda la historia) para separar nuevos de recurrentes.
    const firsts = new Map<string, number>();
    const prior = await this.prisma.booking.groupBy({
      by: ['clientId'],
      where: { barbershopId, status: 'ATTENDED' },
      _min: { startAt: true },
    });
    for (const p of prior) firsts.set(`u:${p.clientId}`, p._min.startAt!.getTime());
    const priorSales = await this.prisma.localSale.groupBy({
      by: ['shopClientId'],
      where: { barbershopId, status: 'COMPLETED', shopClientId: { not: null } },
      _min: { soldAt: true },
    });
    for (const p of priorSales) {
      const key = `c:${p.shopClientId}`;
      firsts.set(key, Math.min(firsts.get(key) ?? Infinity, p._min.soldAt!.getTime()));
    }

    type Acc = {
      app: number;
      local: number;
      count: number;
      clients: Map<string, number>;
      services: Map<string, number>;
    };
    const acc = new Map<string, Acc>();
    const bucket = (k: string): Acc => {
      let a = acc.get(k);
      if (!a)
        acc.set(k, (a = { app: 0, local: 0, count: 0, clients: new Map(), services: new Map() }));
      return a;
    };
    for (const b of bookings) {
      const a = bucket(keyOf(b.startAt));
      a.app += b.subtotalAmount - b.discountTotalAmount;
      a.count++;
      a.clients.set(`u:${b.clientId}`, b.startAt.getTime());
      a.services.set(b.serviceNameSnapshot, (a.services.get(b.serviceNameSnapshot) ?? 0) + 1);
    }
    for (const s of sales) {
      const a = bucket(keyOf(s.soldAt));
      a.local += s.paymentMethod === 'MEMBERSHIP_CREDIT' ? 0 : s.totalAmount;
      a.count++;
      const key = s.shopClient?.userId
        ? `u:${s.shopClient.userId}`
        : s.shopClientId
          ? `c:${s.shopClientId}`
          : null;
      if (key) a.clients.set(key, s.soldAt.getTime());
      for (const l of s.lines)
        a.services.set(l.description, (a.services.get(l.description) ?? 0) + l.quantity);
    }
    const monthsDto: MonthReportDto[] = keys.map((k, i) => {
      const a = acc.get(k) ?? {
        app: 0,
        local: 0,
        count: 0,
        clients: new Map<string, number>(),
        services: new Map<string, number>(),
      };
      const total = a.app + a.local;
      let fresh = 0;
      for (const key of a.clients.keys()) {
        const first = firsts.get(key);
        if (first !== undefined && keyOf(new Date(first)) === k) fresh++;
      }
      const prevKey = keys[i - 1];
      const prev = prevKey ? acc.get(prevKey) : undefined;
      const prevTotal = prev ? prev.app + prev.local : 0;
      return {
        month: k,
        appAmount: a.app,
        localAmount: a.local,
        totalAmount: total,
        count: a.count,
        averageTicket: a.count ? Math.round(total / a.count) : 0,
        newClients: fresh,
        returningClients: a.clients.size - fresh,
        growthPct:
          prevKey && prevTotal > 0
            ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10
            : null,
      };
    });
    const withSales = monthsDto.filter((m) => m.totalAmount > 0);
    const best = withSales.reduce<MonthReportDto | null>(
      (b, m) => (!b || m.totalAmount > b.totalAmount ? m : b),
      null,
    );
    const worst = withSales.reduce<MonthReportDto | null>(
      (w, m) => (!w || m.totalAmount < w.totalAmount ? m : w),
      null,
    );
    const last = monthsDto[monthsDto.length - 1]!;
    const yearAgo = acc.get(yearAgoKey);
    const yearAgoTotal = yearAgo ? yearAgo.app + yearAgo.local : 0;
    const lastServices = acc.get(keys[keys.length - 1]!)?.services ?? new Map<string, number>();
    const prevServices =
      acc.get(keys[keys.length - 2] ?? '')?.services ?? new Map<string, number>();
    const names = new Set([...lastServices.keys(), ...prevServices.keys()]);
    const trends: ServiceTrendDto[] = [...names]
      .map((name) => {
        const cur = lastServices.get(name) ?? 0;
        const prev = prevServices.get(name) ?? 0;
        return {
          name,
          current: cur,
          previous: prev,
          changePct: prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => Math.abs(b.current - b.previous) - Math.abs(a.current - a.previous))
      .slice(0, 8);
    return {
      months: monthsDto,
      bestMonth: best?.month ?? null,
      worstMonth: worst?.month ?? null,
      monthlyAverage: withSales.length
        ? Math.round(withSales.reduce((s, m) => s + m.totalAmount, 0) / withSales.length)
        : 0,
      yearOverYearPct:
        yearAgoTotal > 0
          ? Math.round(((last.totalAmount - yearAgoTotal) / yearAgoTotal) * 1000) / 10
          : null,
      serviceTrends: trends,
    };
  }

  /** Días y horas con más atenciones (reservas atendidas y ventas del local). Plan con reportes completos. */
  async heatmap(userId: string, barbershopId: string, days = 90): Promise<HeatmapDto> {
    await this.access.requireMember(userId, barbershopId);
    await this.entitlements.assertFeature(barbershopId, 'reports_full');
    const since = new Date(this.clock.now() - days * 86_400_000);
    const rows = await this.prisma.$queryRaw<{ weekday: number; hour: number; count: number }[]>`
      SELECT EXTRACT(DOW FROM at AT TIME ZONE 'America/Lima')::int AS weekday,
             EXTRACT(HOUR FROM at AT TIME ZONE 'America/Lima')::int AS hour,
             COUNT(*)::int AS count
        FROM (
          SELECT start_at AS at FROM bookings
           WHERE barbershop_id = ${barbershopId}::uuid AND status = 'ATTENDED' AND start_at >= ${since}
          UNION ALL
          SELECT sold_at AS at FROM local_sales
           WHERE barbershop_id = ${barbershopId}::uuid AND status = 'COMPLETED' AND sold_at >= ${since}
        ) t
       GROUP BY 1, 2`;
    const byDay = new Map<number, number>();
    const byHour = new Map<number, number>();
    for (const r of rows) {
      byDay.set(r.weekday, (byDay.get(r.weekday) ?? 0) + r.count);
      byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + r.count);
    }
    const top = (m: Map<number, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    // Horas abiertas con menos movimiento: franjas del horario con 0–1 atenciones.
    const hours = await this.prisma.businessHour.findMany({
      where: { barbershopId },
      select: { dayOfWeek: true, openTime: true, closeTime: true },
    });
    const count = new Map(rows.map((r) => [`${r.weekday}:${r.hour}`, r.count]));
    const quiet: HeatmapCellDto[] = [];
    for (const h of hours) {
      for (let hour = h.openTime.getUTCHours(); hour < h.closeTime.getUTCHours(); hour++) {
        const c = count.get(`${h.dayOfWeek}:${hour}`) ?? 0;
        if (c <= 1) quiet.push({ weekday: h.dayOfWeek, hour, count: c });
      }
    }
    return {
      cells: rows.sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
      busiestWeekday: top(byDay),
      busiestHour: top(byHour),
      quietSlots: quiet.slice(0, 20),
      days,
    };
  }

  /** La barbería frente a su zona (solo promedios; nunca datos de otra barbería con nombre). */
  async market(userId: string, barbershopId: string, radiusKm = 5): Promise<MarketDto> {
    await this.access.requireMember(userId, barbershopId);
    await this.entitlements.assertFeature(barbershopId, 'reports_full');
    const me = await this.prisma.barbershop.findUniqueOrThrow({
      where: { id: barbershopId },
      select: { districtId: true, ratingAvg: true, ratingCount: true },
    });
    const near = await this.prisma.$queryRaw<
      { id: string; rating: number; rating_count: number }[]
    >`
      SELECT b.id::text AS id, b.rating_avg::float8 AS rating, b.rating_count
        FROM barbershops b, barbershops me
       WHERE me.id = ${barbershopId}::uuid AND b.id <> me.id AND b.deleted_at IS NULL
         AND b.status IN ('OPEN', 'TEMPORARILY_CLOSED')
         AND ST_DWithin(b.location, me.location, ${radiusKm * 1000}::float8)`;
    const ids = near.map((n) => n.id);
    const haircutWhere = {
      deletedAt: null,
      isAvailable: true,
      category: { key: 'haircut' },
    } as const;
    const [zonePrice, myPrice, styles] = await Promise.all([
      ids.length
        ? this.prisma.service.aggregate({
            where: { ...haircutWhere, barbershopId: { in: ids } },
            _avg: { priceAmount: true },
          })
        : null,
      this.prisma.service.aggregate({
        where: { ...haircutWhere, barbershopId },
        _avg: { priceAmount: true },
      }),
      ids.length
        ? this.prisma.booking.groupBy({
            by: ['styleId'],
            where: {
              barbershopId: { in: [...ids, barbershopId] },
              status: 'ATTENDED',
              styleId: { not: null },
              startAt: { gte: new Date(this.clock.now() - 90 * 86_400_000) },
            },
            _count: { _all: true },
            orderBy: { _count: { styleId: 'desc' } },
            take: 5,
          })
        : [],
    ]);
    const styleRows = await this.prisma.serviceStyle.findMany({
      where: { id: { in: styles.map((s) => s.styleId!).filter(Boolean) } },
      select: { id: true, key: true, name: true },
    });
    const styleById = new Map(styleRows.map((s) => [s.id, s]));
    const rated = near.filter((n) => n.rating_count > 0);
    const myRating = me.ratingCount > 0 ? Number(me.ratingAvg) : null;
    return {
      radiusKm,
      competitors: near.length,
      zoneHaircutPrice: zonePrice?._avg.priceAmount ? Math.round(zonePrice._avg.priceAmount) : null,
      myHaircutPrice: myPrice._avg.priceAmount ? Math.round(myPrice._avg.priceAmount) : null,
      zoneRating: rated.length
        ? Math.round((rated.reduce((s, n) => s + n.rating, 0) / rated.length) * 100) / 100
        : null,
      myRating,
      myRatingRank: myRating === null ? null : rated.filter((n) => n.rating > myRating).length + 1,
      topStyles: styles.flatMap((s) => {
        const st = styleById.get(s.styleId!);
        return st ? [{ key: st.key, name: st.name, count: s._count._all }] : [];
      }),
      location: locationOf(me.districtId),
    };
  }

  /** CSV del reporte (requiere "exportar reportes"). */
  async salesCsv(userId: string, barbershopId: string, query: ReportsQueryDto): Promise<string> {
    await this.access.requireMember(userId, barbershopId);
    await this.entitlements.assertFeature(barbershopId, 'reports_export');
    const report = await this.sales(userId, barbershopId, query);
    const lines = ['dia,app_soles,local_soles,atenciones'];
    for (const d of report.byDay) {
      lines.push(
        [d.day, (d.appAmount / 100).toFixed(2), (d.localAmount / 100).toFixed(2), d.count].join(
          ',',
        ),
      );
    }
    lines.push('', 'barbero,atenciones,soles,comision_soles');
    for (const b of report.byBarber) {
      lines.push(
        [
          csv(b.barberName),
          b.count,
          (b.amount / 100).toFixed(2),
          (b.commissionAmount / 100).toFixed(2),
        ].join(','),
      );
    }
    return lines.join('\n') + '\n';
  }

  async setBarberCommission(
    userId: string,
    barbershopId: string,
    barberId: string,
    dto: BarberCommissionDto,
  ): Promise<{ commissionBp: number | null }> {
    await this.access.requireMember(userId, barbershopId, ['OWNER']);
    const { count } = await this.prisma.barber.updateMany({
      where: { id: barberId, barbershopId, deletedAt: null },
      data: { commissionBp: dto.commissionBp },
    });
    if (!count)
      throw new AppException(ErrorCode.NOT_FOUND, 'El barbero no existe.', HttpStatus.NOT_FOUND);
    return { commissionBp: dto.commissionBp };
  }
}

/** Escapa un texto para CSV (y evita fórmulas al abrirlo en una hoja de cálculo). */
function csv(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
