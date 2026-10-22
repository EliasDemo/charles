import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { DAY_MS } from '../billing/billing-gateway';
import { EntitlementsService } from '../plans/entitlements.service';
import type {
  BarberCommissionDto,
  ReportBarberDto,
  ReportsQueryDto,
  SalesReportDto,
} from './dto/shop.dto';

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
