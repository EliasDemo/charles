import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { TimeBlock } from '../../generated/prisma/client';
import { BarbersService } from '../barbers/barbers.service';
import {
  BarbershopAccessService,
  forbidden,
  notFound,
} from '../barbershops/barbershop-access.service';
import { BookingsReadService } from '../bookings/bookings-read.service';
import { AvailabilityService } from './availability.service';
import { containedIn, intersect, union } from './engine/intervals';
import {
  type DayOfWeek,
  isLocalTime,
  localDateOf,
  localDayBounds,
  minutesOf,
  type WeeklyWindow,
  windowsOn,
} from './engine/local-time';
import type {
  BarberScheduleDto,
  BarberScheduleUpdateDto,
  BusinessHoursDto,
  BusinessHoursUpdateDto,
  CreateTimeBlockDto,
  DayScheduleDto,
  TimeBlockDto,
  TimeBlockListQueryDto,
  WeeklyScheduleDto,
} from './dto/availability.dto';
import { ScheduleRepository } from './schedule.repository';

const FIVE_MINUTES = 5 * 60_000;
const MAX_BLOCK_MS = 366 * 24 * 3600_000;

type Actor = { kind: 'manager' } | { kind: 'barber'; barberId: string };

function invalid(field: string, constraint: string): AppException {
  return new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: [constraint] }],
  );
}

/** Valida una semana: días únicos, horas múltiplo de 5, inicio < fin, sin solapes en el día. */
function toWindows(dto: WeeklyScheduleDto): WeeklyWindow[] {
  const seen = new Set<number>();
  const windows: WeeklyWindow[] = [];
  dto.days.forEach((day, d) => {
    if (seen.has(day.dayOfWeek)) throw invalid(`days.${d}.dayOfWeek`, 'uniqueDayOfWeek');
    seen.add(day.dayOfWeek);
    const sorted = [...day.windows].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    sorted.forEach((w, i) => {
      const field = `days.${d}.windows`;
      if (!isLocalTime(w.start) || !isLocalTime(w.end)) throw invalid(field, 'isLocalTime');
      if (minutesOf(w.start) % 5 !== 0 || minutesOf(w.end) % 5 !== 0)
        throw invalid(field, 'multipleOf5Minutes');
      if (minutesOf(w.end) <= minutesOf(w.start)) throw invalid(field, 'endAfterStart');
      const previous = sorted[i - 1];
      if (previous && minutesOf(w.start) < minutesOf(previous.end))
        throw invalid(field, 'noOverlap');
      windows.push({ dayOfWeek: day.dayOfWeek as DayOfWeek, start: w.start, end: w.end });
    });
  });
  return windows;
}

function toDays(windows: WeeklyWindow[]): DayScheduleDto[] {
  const byDay = new Map<number, { start: string; end: string }[]>();
  for (const w of windows)
    byDay.set(w.dayOfWeek, [...(byDay.get(w.dayOfWeek) ?? []), { start: w.start, end: w.end }]);
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([dayOfWeek, list]) => ({
      dayOfWeek,
      windows: list.sort((a, b) => a.start.localeCompare(b.start)),
    }));
}

const serialize = (windows: WeeklyWindow[]) =>
  toDays(windows)
    .map((d) => `${d.dayOfWeek}:${d.windows.map((w) => `${w.start}-${w.end}`).join(',')}`)
    .join(' ');

/** Gestión de horarios y bloqueos (RF-DIS-001, RF-BRB-003). */
@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ScheduleRepository,
    private readonly access: BarbershopAccessService,
    private readonly barbers: BarbersService,
    private readonly bookings: BookingsReadService,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Horario público e indicador "abierta ahora" (RF-BAR-002, RF-BAR-004). */
  async publicBusinessHours(barbershopId: string): Promise<BusinessHoursDto> {
    const info = (await this.access.publicScheduleInfo([barbershopId])).get(barbershopId);
    if (!info) throw notFound();
    const windows = (await this.repository.businessHours([barbershopId])).get(barbershopId) ?? [];
    const now = this.clock.now();
    const today = localDateOf(now, info.timezone);
    const open = windowsOn(windows, today, info.timezone).some(
      (w) => w.start <= now && now < w.end,
    );
    const blocks = await this.repository.blocks([barbershopId], {
      from: new Date(now),
      to: new Date(now + 1),
    });
    const blockedNow = blocks.some((b) => b.barberId === null);
    return {
      timezone: info.timezone,
      isOpenNow: info.status === 'OPEN' && open && !blockedNow,
      days: toDays(windows),
    };
  }

  /** RF-DIS-001: OWNER o MANAGER reemplazan la semana. Las reservas existentes se mantienen. */
  async putBusinessHours(
    userId: string,
    barbershopId: string,
    dto: WeeklyScheduleDto,
    ip: string | null,
  ): Promise<BusinessHoursUpdateDto> {
    await this.access.requireMember(userId, barbershopId);
    const windows = toWindows(dto);
    const before = (await this.repository.businessHours([barbershopId])).get(barbershopId) ?? [];
    await this.prisma.$transaction(async (tx) => {
      await this.repository.replaceBusinessHours(tx, barbershopId, windows);
      if (serialize(before) !== serialize(windows)) {
        await this.audit.record(
          {
            actorId: userId,
            action: 'barbershop.business_hours_changed',
            entityType: 'barbershop',
            entityId: barbershopId,
            changes: {
              values: { businessHours: { from: serialize(before), to: serialize(windows) } },
            },
            ip,
          },
          tx,
        );
      }
    });
    const timezone = await this.access.timezoneOf(barbershopId);
    const barberIds = await this.barbers.idsOfBarbershop(barbershopId);
    const schedules = await this.repository.barberSchedules(barberIds);
    const outside = await this.countOutside(
      barberIds,
      timezone,
      windows,
      (id) => schedules.get(id) ?? null,
    );
    const { isOpenNow } = await this.openNowOnly(barbershopId);
    return { timezone, isOpenNow, days: toDays(windows), bookingsOutsideSchedule: outside };
  }

  /** RF-BRB-003: horario del barbero. Responsables lo editan; el barbero puede verlo. */
  async getBarberSchedule(
    userId: string,
    barbershopId: string,
    barberId: string,
  ): Promise<BarberScheduleDto> {
    await this.actorFor(userId, barbershopId, barberId);
    const schedule = (await this.repository.barberSchedules([barberId])).get(barberId);
    return { barberId, inheritsBusinessHours: !schedule, days: toDays(schedule ?? []) };
  }

  /** Solo responsables. Una semana vacía significa "hereda el horario de la barbería". */
  async putBarberSchedule(
    userId: string,
    barbershopId: string,
    barberId: string,
    dto: WeeklyScheduleDto,
    ip: string | null,
  ): Promise<BarberScheduleUpdateDto> {
    const actor = await this.actorFor(userId, barbershopId, barberId);
    if (actor.kind !== 'manager') throw forbidden();
    const windows = toWindows(dto);
    const before = (await this.repository.barberSchedules([barberId])).get(barberId) ?? [];
    await this.prisma.$transaction(async (tx) => {
      await this.repository.replaceBarberSchedule(tx, barberId, windows);
      if (serialize(before) !== serialize(windows)) {
        await this.audit.record(
          {
            actorId: userId,
            action: 'barber.schedule_changed',
            entityType: 'barber',
            entityId: barberId,
            changes: {
              values: {
                schedule: { from: serialize(before) || null, to: serialize(windows) || null },
              },
            },
            ip,
          },
          tx,
        );
      }
    });
    const timezone = await this.access.timezoneOf(barbershopId);
    const shopHours = (await this.repository.businessHours([barbershopId])).get(barbershopId) ?? [];
    const outside = await this.countOutside([barberId], timezone, shopHours, () =>
      windows.length > 0 ? windows : null,
    );
    return {
      barberId,
      inheritsBusinessHours: windows.length === 0,
      days: toDays(windows),
      bookingsOutsideSchedule: outside,
    };
  }

  /** Responsables ven todos los bloqueos; un barbero, solo los suyos (con motivo). */
  async listBlocks(
    userId: string,
    barbershopId: string,
    query: TimeBlockListQueryDto,
  ): Promise<TimeBlockDto[]> {
    const actor = await this.actorFor(userId, barbershopId);
    const settings = await this.availability.loadSettings();
    const from = query.from ?? new Date(this.clock.now());
    const to = query.to ?? new Date(this.clock.now() + (settings.horizonDays + 1) * 24 * 3600_000);
    const blocks = await this.repository.blocks([barbershopId], { from, to });
    return blocks
      .filter((b) => actor.kind === 'manager' || b.barberId === actor.barberId)
      .slice(0, 500)
      .map(toBlockDto);
  }

  /** RF-DIS-001 / RF-BRB-003. Rechaza (409) un bloqueo que choca con reservas activas. */
  async createBlock(
    userId: string,
    barbershopId: string,
    dto: CreateTimeBlockDto,
    ip: string | null,
  ): Promise<TimeBlockDto> {
    const actor = await this.actorFor(userId, barbershopId, dto.barberId);
    if (actor.kind === 'barber' && dto.barberId !== actor.barberId) throw forbidden();
    const start = dto.startAt.getTime();
    const end = dto.endAt.getTime();
    if (end <= start) throw invalid('endAt', 'endAfterStart');
    if (start % FIVE_MINUTES !== 0 || end % FIVE_MINUTES !== 0)
      throw invalid('startAt', 'multipleOf5Minutes');
    if (end - start > MAX_BLOCK_MS) throw invalid('endAt', 'maxDuration');

    const barberIds = dto.barberId
      ? [dto.barberId]
      : await this.barbers.idsOfBarbershop(barbershopId);
    const busy = await this.bookings.busyIntervals(
      barberIds,
      { from: dto.startAt, to: dto.endAt },
      new Date(this.clock.now()),
    );
    const affected = [...busy.values()].reduce((n, list) => n + list.length, 0);
    if (affected > 0) {
      throw new AppException(
        ErrorCode.BLOCK_OVERLAPS_BOOKINGS,
        'El bloqueo choca con reservas activas. Gestiónalas antes de bloquear ese horario.',
        HttpStatus.CONFLICT,
        [{ affectedBookings: affected }],
      );
    }

    const block = await this.prisma.$transaction(async (tx) => {
      const created = await tx.timeBlock.create({
        data: {
          barbershopId,
          barberId: dto.barberId ?? null,
          startAt: dto.startAt,
          endAt: dto.endAt,
          type: dto.type,
          reason: dto.reason ?? null,
        },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'time_block.created',
          entityType: 'time_block',
          entityId: created.id,
          changes: {
            barbershopId,
            barberId: created.barberId,
            values: {
              type: { from: null, to: created.type },
              startAt: { from: null, to: created.startAt.toISOString() },
              endAt: { from: null, to: created.endAt.toISOString() },
            },
            ...(created.reason ? { personalFields: ['reason'] } : {}),
          },
          ip,
        },
        tx,
      );
      return created;
    });
    return toBlockDto(block);
  }

  async deleteBlock(
    userId: string,
    barbershopId: string,
    blockId: string,
    ip: string | null,
  ): Promise<void> {
    const block = await this.prisma.timeBlock.findFirst({ where: { id: blockId, barbershopId } });
    const actor = await this.actorFor(userId, barbershopId, block?.barberId ?? undefined);
    if (!block)
      throw new AppException(ErrorCode.NOT_FOUND, 'El bloqueo no existe.', HttpStatus.NOT_FOUND);
    if (actor.kind === 'barber' && block.barberId !== actor.barberId) throw forbidden();
    await this.prisma.$transaction(async (tx) => {
      await tx.timeBlock.delete({ where: { id: blockId } });
      await this.audit.record(
        {
          actorId: userId,
          action: 'time_block.deleted',
          entityType: 'time_block',
          entityId: blockId,
          ip,
        },
        tx,
      );
    });
  }

  /**
   * Responsable (OWNER o MANAGER) o barbero vinculado de esa barbería. Si se indica un barbero,
   * debe pertenecer a la barbería. Quien no tiene relación con la barbería recibe 404.
   */
  private async actorFor(userId: string, barbershopId: string, barberId?: string): Promise<Actor> {
    let actor: Actor | null = null;
    if (await this.access.isMember(barbershopId, userId)) {
      await this.access.requireMember(userId, barbershopId); // excluye barberías eliminadas
      actor = { kind: 'manager' };
    } else {
      const own = await this.barbers.linkedBarberIdOf(barbershopId, userId);
      if (own) actor = { kind: 'barber', barberId: own };
    }
    if (!actor) throw notFound();
    if (barberId && !(await this.barbers.findInBarbershop(barbershopId, barberId))) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El barbero no existe.', HttpStatus.NOT_FOUND);
    }
    return actor;
  }

  /** Reservas futuras activas que no caben en el horario efectivo (barbero ∩ barbería). */
  private async countOutside(
    barberIds: string[],
    timezone: string,
    shopHours: WeeklyWindow[],
    scheduleOf: (barberId: string) => WeeklyWindow[] | null,
  ): Promise<number> {
    const future = await this.bookings.futureActive(barberIds, new Date(this.clock.now()));
    return future.filter((b) => {
      const date = localDateOf(b.start, timezone);
      const shop = union(windowsOn(shopHours, date, timezone));
      const own = scheduleOf(b.barberId);
      const effective = own ? intersect(windowsOn(own, date, timezone), shop) : shop;
      const day = localDayBounds(date, timezone);
      return !containedIn({ start: Math.max(b.start, day.start), end: b.end }, effective);
    }).length;
  }

  private async openNowOnly(barbershopId: string): Promise<{ isOpenNow: boolean }> {
    try {
      return { isOpenNow: (await this.publicBusinessHours(barbershopId)).isOpenNow };
    } catch {
      return { isOpenNow: false }; // barbería no visible públicamente (por ejemplo, en revisión)
    }
  }
}

function toBlockDto(block: TimeBlock): TimeBlockDto {
  return {
    id: block.id,
    barberId: block.barberId,
    startAt: block.startAt,
    endAt: block.endAt,
    type: block.type,
    reason: block.reason,
  };
}
