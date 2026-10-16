import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

const ACTIVE_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED'] as const;

/**
 * Consultas de solo lectura sobre reservas para otros módulos (CLAUDE.md §3: nadie toca la tabla
 * `bookings` directamente). La gestión de reservas llega en la Fase 7.
 */
@Injectable()
export class BookingsReadService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Intervalos ocupados por barbero, por lotes: CONFIRMED y PENDING_PAYMENT **no vencidas** que
   * tocan el rango. Una PENDING_PAYMENT vencida no bloquea el cálculo (aunque la restricción de
   * exclusión la siga contando hasta que se marque EXPIRED, Fase 7). Sin datos del cliente.
   */
  async busyIntervals(
    barberIds: string[],
    range: { from: Date; to: Date },
    now: Date,
  ): Promise<Map<string, { start: number; end: number }[]>> {
    // Carrera del barbero: quien trabaja en varias barberías tampoco está libre cuando tiene una
    // cita en otra. Se suman las reservas de su perfil, atribuidas a cada vínculo pedido.
    const links = await this.prisma.barber.findMany({
      where: { id: { in: barberIds }, barberProfileId: { not: null } },
      select: { id: true, barberProfileId: true },
    });
    const linksByProfile = new Map<string, string[]>();
    for (const l of links) {
      linksByProfile.set(l.barberProfileId!, [
        ...(linksByProfile.get(l.barberProfileId!) ?? []),
        l.id,
      ]);
    }
    const rows = await this.prisma.booking.findMany({
      where: {
        OR: [
          { barberId: { in: barberIds } },
          ...(linksByProfile.size > 0
            ? [{ barberProfileId: { in: [...linksByProfile.keys()] } }]
            : []),
        ],
        startAt: { lt: range.to },
        endAt: { gt: range.from },
        AND: [
          { OR: [{ status: 'CONFIRMED' }, { status: 'PENDING_PAYMENT', expiresAt: { gt: now } }] },
        ],
      },
      select: { id: true, barberId: true, barberProfileId: true, startAt: true, endAt: true },
    });
    const result = new Map<string, { start: number; end: number }[]>();
    const requested = new Set(barberIds);
    for (const r of rows) {
      const interval = { start: r.startAt.getTime(), end: r.endAt.getTime() };
      const owners = new Set<string>();
      if (requested.has(r.barberId)) owners.add(r.barberId);
      for (const id of (r.barberProfileId && linksByProfile.get(r.barberProfileId)) || []) {
        owners.add(id);
      }
      for (const id of owners) result.set(id, [...(result.get(id) ?? []), interval]);
    }
    return result;
  }

  /** Reservas activas futuras de los barberos (para avisar de reservas fuera de un horario nuevo). */
  async futureActive(
    barberIds: string[],
    now: Date,
  ): Promise<{ barberId: string; start: number; end: number }[]> {
    const rows = await this.prisma.booking.findMany({
      where: {
        barberId: { in: barberIds },
        startAt: { gt: now },
        OR: [{ status: 'CONFIRMED' }, { status: 'PENDING_PAYMENT', expiresAt: { gt: now } }],
      },
      select: { barberId: true, startAt: true, endAt: true },
    });
    return rows.map((r) => ({
      barberId: r.barberId,
      start: r.startAt.getTime(),
      end: r.endAt.getTime(),
    }));
  }

  /** ¿Hay reservas activas (pendientes de pago o confirmadas) que aún no empiezan? */
  async hasFutureActive(
    filter: { barberId: string } | { barbershopId: string },
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const count = await tx.booking.count({
      where: { ...filter, status: { in: [...ACTIVE_STATUSES] }, startAt: { gt: new Date() } },
    });
    return count > 0;
  }
}
