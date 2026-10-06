import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma, TimeBlock } from '../../generated/prisma/client';
import type { DayOfWeek, WeeklyWindow } from './engine/local-time';

/** Las columnas TIME de Prisma llegan como Date del 1970-01-01 en UTC. */
export const toHHmm = (time: Date): string => time.toISOString().slice(11, 16);
export const fromHHmm = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);

/** Acceso a las tablas propias del módulo: business_hours, barber_schedules y time_blocks. */
@Injectable()
export class ScheduleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async businessHours(barbershopIds: string[]): Promise<Map<string, WeeklyWindow[]>> {
    const rows = await this.prisma.businessHour.findMany({
      where: { barbershopId: { in: barbershopIds } },
      orderBy: [{ dayOfWeek: 'asc' }, { openTime: 'asc' }],
    });
    const result = new Map<string, WeeklyWindow[]>();
    for (const r of rows) {
      const list = result.get(r.barbershopId) ?? [];
      list.push({
        dayOfWeek: r.dayOfWeek as DayOfWeek,
        start: toHHmm(r.openTime),
        end: toHHmm(r.closeTime),
      });
      result.set(r.barbershopId, list);
    }
    return result;
  }

  /** Horario propio de cada barbero; un barbero sin filas no aparece (hereda el de la barbería). */
  async barberSchedules(barberIds: string[]): Promise<Map<string, WeeklyWindow[]>> {
    const rows = await this.prisma.barberSchedule.findMany({
      where: { barberId: { in: barberIds } },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
    const result = new Map<string, WeeklyWindow[]>();
    for (const r of rows) {
      const list = result.get(r.barberId) ?? [];
      list.push({
        dayOfWeek: r.dayOfWeek as DayOfWeek,
        start: toHHmm(r.startTime),
        end: toHHmm(r.endTime),
      });
      result.set(r.barberId, list);
    }
    return result;
  }

  /** Bloqueos que tocan el rango, de varias barberías a la vez. */
  async blocks(barbershopIds: string[], range: { from: Date; to: Date }): Promise<TimeBlock[]> {
    return this.prisma.timeBlock.findMany({
      where: {
        barbershopId: { in: barbershopIds },
        startAt: { lt: range.to },
        endAt: { gt: range.from },
      },
      orderBy: { startAt: 'asc' },
    });
  }

  async replaceBusinessHours(
    tx: Prisma.TransactionClient,
    barbershopId: string,
    windows: WeeklyWindow[],
  ): Promise<void> {
    await tx.businessHour.deleteMany({ where: { barbershopId } });
    await tx.businessHour.createMany({
      data: windows.map((w) => ({
        barbershopId,
        dayOfWeek: w.dayOfWeek,
        openTime: fromHHmm(w.start),
        closeTime: fromHHmm(w.end),
      })),
    });
  }

  async replaceBarberSchedule(
    tx: Prisma.TransactionClient,
    barberId: string,
    windows: WeeklyWindow[],
  ): Promise<void> {
    await tx.barberSchedule.deleteMany({ where: { barberId } });
    await tx.barberSchedule.createMany({
      data: windows.map((w) => ({
        barberId,
        dayOfWeek: w.dayOfWeek,
        startTime: fromHHmm(w.start),
        endTime: fromHHmm(w.end),
      })),
    });
  }
}
