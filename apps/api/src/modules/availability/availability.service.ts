import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { TimeBlock } from '../../generated/prisma/client';
import type { BarbershopStatus } from '../../generated/prisma/enums';
import { BarbersService } from '../barbers/barbers.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { BookingsReadService } from '../bookings/bookings-read.service';
import { ServicesService } from '../services/services.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { computeSlots, type Slot } from './engine/compute-slots';
import type { Interval } from './engine/intervals';
import {
  addDays,
  localDateOf,
  localDayBounds,
  type WeeklyWindow,
  windowsOn,
} from './engine/local-time';
import { ScheduleRepository } from './schedule.repository';

/** Qué se consulta: un servicio de una barbería, opcionalmente con un barbero concreto. */
export interface AvailabilityRequest {
  barbershopId: string;
  serviceId: string;
  barberId?: string;
}

/** Todo lo que el motor necesita de una barbería para un servicio (cargado por lotes). */
export interface ShopContext {
  timezone: string;
  status: BarbershopStatus;
  businessHours: WeeklyWindow[];
  shopBlocks: Interval[];
  serviceDurationMinutes: number;
  barbers: { id: string; schedule: WeeklyWindow[] | null; blocks: Interval[]; busy: Interval[] }[];
}

export interface AvailabilitySettings {
  slotIntervalMinutes: number;
  minLeadMinutes: number;
  horizonDays: number;
  nowWindowMinutes: number;
}

export const AVAILABILITY_DEFAULTS: AvailabilitySettings = {
  slotIntervalMinutes: 15,
  minLeadMinutes: 0,
  horizonDays: 30,
  nowWindowMinutes: 30,
};

const DAY_MS = 24 * 3600_000;

const notFound = (what: 'barbershop' | 'service' | 'barber'): AppException =>
  new AppException(
    ErrorCode.NOT_FOUND,
    {
      barbershop: 'La barbería no existe.',
      service: 'El servicio no existe o no está disponible en esta barbería.',
      barber: 'El barbero no existe o no realiza este servicio.',
    }[what],
    HttpStatus.NOT_FOUND,
  );

const keyOf = (r: AvailabilityRequest): string =>
  `${r.barbershopId}|${r.serviceId}|${r.barberId ?? '*'}`;

/**
 * Disponibilidad calculada, no almacenada (CLAUDE.md §4.1 y §9). Carga los datos de varias
 * barberías en pocas consultas (por lotes, Fase 6) y delega el cálculo en `computeSlots` (pura).
 * "Hoy", el horizonte y el rechazo de fechas pasadas se evalúan en la zona de cada barbería.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly repository: ScheduleRepository,
    private readonly access: BarbershopAccessService,
    private readonly services: ServicesService,
    private readonly barbers: BarbersService,
    private readonly bookings: BookingsReadService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async loadSettings(): Promise<AvailabilitySettings> {
    const [slotIntervalMinutes, minLeadMinutes, horizonDays, nowWindowMinutes] = await Promise.all([
      this.settings.positiveInt(
        SettingKey.SLOT_INTERVAL_MINUTES,
        AVAILABILITY_DEFAULTS.slotIntervalMinutes,
      ),
      this.nonNegativeInt(SettingKey.MIN_LEAD_TIME_MINUTES, AVAILABILITY_DEFAULTS.minLeadMinutes),
      this.settings.positiveInt(SettingKey.BOOKING_HORIZON_DAYS, AVAILABILITY_DEFAULTS.horizonDays),
      this.settings.positiveInt(
        SettingKey.NOW_WINDOW_MINUTES,
        AVAILABILITY_DEFAULTS.nowWindowMinutes,
      ),
    ]);
    return { slotIntervalMinutes, minLeadMinutes, horizonDays, nowWindowMinutes };
  }

  /**
   * Carga por lotes. Devuelve un contexto por solicitud válida (barbería visible, servicio
   * disponible de esa barbería y, si se pidió, barbero que lo realiza); las demás quedan en null.
   */
  async loadContexts(
    requests: AvailabilityRequest[],
    range: { from: number; to: number },
  ): Promise<Map<string, ShopContext | null>> {
    const now = new Date(this.clock.now());
    const shopIds = [...new Set(requests.map((r) => r.barbershopId))];
    const serviceIds = [...new Set(requests.map((r) => r.serviceId))];

    const [shops, durations, barbersByService] = await Promise.all([
      this.access.publicScheduleInfo(shopIds),
      this.services.bookableDurations(serviceIds),
      this.barbers.activeBarbersByService(serviceIds),
    ]);
    const barberIds = [...new Set([...barbersByService.values()].flat())];
    const dateRange = { from: new Date(range.from), to: new Date(range.to) };
    const [hours, schedules, blocks, busy] = await Promise.all([
      this.repository.businessHours(shopIds),
      this.repository.barberSchedules(barberIds),
      this.repository.blocks(shopIds, dateRange),
      this.bookings.busyIntervals(barberIds, dateRange, now),
    ]);

    const result = new Map<string, ShopContext | null>();
    for (const request of requests) {
      const shop = shops.get(request.barbershopId);
      const service = durations.get(request.serviceId);
      if (!shop || !service || service.barbershopId !== request.barbershopId) {
        result.set(keyOf(request), null);
        continue;
      }
      const offering = barbersByService.get(request.serviceId) ?? [];
      const chosen = request.barberId ? offering.filter((id) => id === request.barberId) : offering;
      if (request.barberId && chosen.length === 0) {
        result.set(keyOf(request), null);
        continue;
      }
      const shopBlocks = blocks.filter((b) => b.barbershopId === request.barbershopId);
      result.set(keyOf(request), {
        timezone: shop.timezone,
        status: shop.status,
        businessHours: hours.get(request.barbershopId) ?? [],
        serviceDurationMinutes: service.durationMinutes,
        shopBlocks: shopBlocks.filter((b) => b.barberId === null).map(toInterval),
        barbers: chosen.map((id) => ({
          id,
          schedule: schedules.get(id) ?? null,
          blocks: shopBlocks.filter((b) => b.barberId === id).map(toInterval),
          busy: busy.get(id) ?? [],
        })),
      });
    }
    return result;
  }

  /** RF-DIS-003: turnos de una fecha local de la barbería. */
  async slotsForDate(
    request: AvailabilityRequest,
    localDate: string,
  ): Promise<{ timezone: string; slots: Slot[] }> {
    const settings = await this.loadSettings();
    const timezone = await this.timezoneOrThrow(request.barbershopId);
    this.assertWithinHorizon(localDate, timezone, settings);
    const bounds = localDayBounds(localDate, timezone);
    const context = await this.contextOrThrow(request, { from: bounds.start, to: bounds.end });
    return { timezone, slots: this.compute(context, localDate, settings) };
  }

  /** RF-DIS-004: primer turno disponible desde ahora hasta el horizonte (en la zona de la barbería). */
  async nextAvailable(request: AvailabilityRequest): Promise<Slot | null> {
    const settings = await this.loadSettings();
    const timezone = await this.timezoneOrThrow(request.barbershopId);
    const today = localDateOf(this.clock.now(), timezone);
    const last = addDays(today, settings.horizonDays);
    const context = await this.contextOrThrow(request, {
      from: localDayBounds(today, timezone).start,
      to: localDayBounds(last, timezone).end,
    });
    for (let date = today; date <= last; date = addDays(date, 1)) {
      const first = this.compute(context, date, settings)[0];
      if (first) return first;
    }
    return null;
  }

  /**
   * RF-DIS-002, por lotes: para cada solicitud, el primer turno que empieza dentro de la ventana
   * "ahora" (null si no hay). Las solicitudes inválidas (barbería no visible, servicio ajeno...)
   * no aparecen en el resultado.
   */
  async availableNowBatch(requests: AvailabilityRequest[]): Promise<Map<string, Slot | null>> {
    const settings = await this.loadSettings();
    const now = this.clock.now();
    const windowEnd = now + settings.nowWindowMinutes * 60_000;
    // Cubre "hoy" y "mañana" en cualquier zona: la ventana puede cruzar la medianoche local.
    const contexts = await this.loadContexts(requests, {
      from: now - DAY_MS,
      to: windowEnd + 2 * DAY_MS,
    });
    const result = new Map<string, Slot | null>();
    for (const request of requests) {
      const context = contexts.get(keyOf(request));
      if (!context) continue;
      const dates = [
        ...new Set([localDateOf(now, context.timezone), localDateOf(windowEnd, context.timezone)]),
      ];
      const first = dates
        .flatMap((d) => this.compute(context, d, settings))
        .find((s) => s.start <= windowEnd);
      result.set(keyOf(request), first ?? null);
    }
    return result;
  }

  /**
   * Búsqueda (Fase 6), por lotes: primer turno de la fecha local indicada (en la zona de cada
   * barbería). Fechas pasadas o fuera del horizonte dan null; solicitudes inválidas no aparecen.
   */
  async availableOnDateBatch(
    requests: AvailabilityRequest[],
    localDate: string,
  ): Promise<Map<string, Slot | null>> {
    const settings = await this.loadSettings();
    // La fecha local cae, en cualquier zona, dentro de [fecha 00:00 UTC − 1 día, + 2 días].
    const utcMidnight = Date.parse(`${localDate}T00:00:00Z`);
    const contexts = await this.loadContexts(requests, {
      from: utcMidnight - DAY_MS,
      to: utcMidnight + 2 * DAY_MS,
    });
    const result = new Map<string, Slot | null>();
    for (const request of requests) {
      const context = contexts.get(keyOf(request));
      if (!context) continue;
      const today = this.todayIn(context.timezone);
      const inRange = localDate >= today && localDate <= addDays(today, settings.horizonDays);
      result.set(
        keyOf(request),
        inRange ? (this.compute(context, localDate, settings)[0] ?? null) : null,
      );
    }
    return result;
  }

  /**
   * "Abierta ahora", por lotes: barbería visible en OPEN, dentro de su horario y sin bloqueo
   * general en este instante. Las barberías no visibles quedan en false.
   */
  async openNowBatch(barbershopIds: string[]): Promise<Map<string, boolean>> {
    const now = this.clock.now();
    const [infos, hours, blocks] = await Promise.all([
      this.access.publicScheduleInfo(barbershopIds),
      this.repository.businessHours(barbershopIds),
      this.repository.blocks(barbershopIds, { from: new Date(now), to: new Date(now + 1) }),
    ]);
    const blocked = new Set(blocks.filter((b) => b.barberId === null).map((b) => b.barbershopId));
    const result = new Map<string, boolean>();
    for (const id of barbershopIds) {
      const info = infos.get(id);
      const open =
        !!info &&
        info.status === 'OPEN' &&
        !blocked.has(id) &&
        windowsOn(hours.get(id) ?? [], localDateOf(now, info.timezone), info.timezone).some(
          (w) => w.start <= now && now < w.end,
        );
      result.set(id, open);
    }
    return result;
  }

  async availableNow(request: AvailabilityRequest): Promise<Slot | null> {
    await this.timezoneOrThrow(request.barbershopId);
    const result = await this.availableNowBatch([request]);
    if (!result.has(keyOf(request)))
      throw request.barberId ? notFound('barber') : notFound('service');
    return result.get(keyOf(request)) ?? null;
  }

  /** Bloqueos de una barbería que tocan el rango (agenda del personal, Fase 9). */
  blocksBetween(
    barbershopId: string,
    range: { from: Date; to: Date },
  ): Promise<
    {
      id: string;
      barberId: string | null;
      startAt: Date;
      endAt: Date;
      type: TimeBlock['type'];
      reason: string | null;
    }[]
  > {
    return this.repository.blocks([barbershopId], range);
  }

  /** "Hoy" en la zona de la barbería. */
  todayIn(timezone: string): string {
    return localDateOf(this.clock.now(), timezone);
  }

  private compute(context: ShopContext, localDate: string, settings: AvailabilitySettings): Slot[] {
    return computeSlots({
      ...context,
      shopStatus: context.status,
      localDate,
      now: this.clock.now(),
      slotIntervalMinutes: settings.slotIntervalMinutes,
      minLeadMinutes: settings.minLeadMinutes,
    });
  }

  /** Fechas pasadas o más allá del horizonte se rechazan según el calendario de la barbería. */
  private assertWithinHorizon(
    localDate: string,
    timezone: string,
    settings: AvailabilitySettings,
  ): void {
    const today = this.todayIn(timezone);
    const last = addDays(today, settings.horizonDays);
    if (localDate < today || localDate > last) {
      throw new AppException(
        ErrorCode.DATE_OUT_OF_RANGE,
        localDate < today
          ? 'La fecha ya pasó en el horario de la barbería.'
          : `Solo se puede consultar hasta ${settings.horizonDays} días hacia adelante.`,
        HttpStatus.BAD_REQUEST,
        [{ today, lastBookableDate: last, timezone }],
      );
    }
  }

  private async timezoneOrThrow(barbershopId: string): Promise<string> {
    const info = (await this.access.publicScheduleInfo([barbershopId])).get(barbershopId);
    if (!info) throw notFound('barbershop');
    return info.timezone;
  }

  private async contextOrThrow(
    request: AvailabilityRequest,
    range: { from: number; to: number },
  ): Promise<ShopContext> {
    const context = (await this.loadContexts([request], range)).get(keyOf(request));
    if (!context) throw request.barberId ? notFound('barber') : notFound('service');
    return context;
  }

  private async nonNegativeInt(key: string, fallback: number): Promise<number> {
    const value = await this.settings.get(key);
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
  }
}

function toInterval(block: { startAt: Date; endAt: Date }): Interval {
  return { start: block.startAt.getTime(), end: block.endAt.getTime() };
}

export { keyOf as availabilityKey };
