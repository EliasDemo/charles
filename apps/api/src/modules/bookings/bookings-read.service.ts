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
