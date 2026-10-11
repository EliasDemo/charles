import { DateTime } from 'luxon';
import { ServicesService } from '../services/services.service';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { BookingStatus } from '../../generated/prisma/enums';
import { AvailabilityService } from '../availability/availability.service';
import { addDays, localDayBounds } from '../availability/engine/local-time';
import { BarbersService } from '../barbers/barbers.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import {
  ATTENDANCE_DEFAULTS,
  attendedAllowed,
  correctionAllowed,
  NO_SHOW_DEFAULTS,
  noShowAllowed,
} from './booking-policy';
import { cancellationDecision } from './booking-policy';
import { BookingStateMachine, SYSTEM_ACTOR } from './booking-state-machine';
import type { AgendaDto, AttendanceCorrectionDto } from './dto/attendance.dto';

export const AUTO_CLOSE_REASON = 'auto_close';
const AUTO_CLOSE_BATCH = 100;
const AGENDA_STATUSES: BookingStatus[] = ['CONFIRMED', 'ATTENDED', 'NO_SHOW', 'PENDING_PAYMENT'];

interface AttendanceSettings {
  autoCloseHours: number;
  correctionHours: number;
  noShowAfterMinutes: number;
  noShowWindowHours: number;
}

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La reserva no existe.', HttpStatus.NOT_FOUND);

/**
 * Atención e inasistencias (Fase 9, RF-ATE-001…003). Las marcas pasan por la máquina de estados;
 * las correcciones, por `correct()`. El no-show (Fase 8A) vive en `BookingsService.markNoShow`;
 * aquí solo se integra en la agenda y en la corrección.
 */

/** Días hacia atrás que se puede consultar la agenda. */
export const AGENDA_PAST_DAYS = 90;
@Injectable()
export class BookingAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: BookingStateMachine,
    private readonly access: BarbershopAccessService,
    private readonly barbers: BarbersService,
    private readonly users: UsersService,
    private readonly availability: AvailabilityService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly services: ServicesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async loadSettings(): Promise<AttendanceSettings> {
    const [autoCloseHours, correctionHours, noShowAfterMinutes, noShowWindowHours] =
      await Promise.all([
        this.settings.positiveInt(
          SettingKey.ATTENDANCE_AUTO_CLOSE_HOURS,
          ATTENDANCE_DEFAULTS.autoCloseHours,
        ),
        this.settings.positiveInt(
          SettingKey.ATTENDANCE_CORRECTION_HOURS,
          ATTENDANCE_DEFAULTS.correctionHours,
        ),
        this.settings.positiveInt(SettingKey.NO_SHOW_AFTER_MINUTES, NO_SHOW_DEFAULTS.afterMinutes),
        this.settings.positiveInt(SettingKey.NO_SHOW_WINDOW_HOURS, NO_SHOW_DEFAULTS.windowHours),
      ]);
    return { autoCloseHours, correctionHours, noShowAfterMinutes, noShowWindowHours };
  }

  /** Quién es el usuario frente a la reserva: la barbería, el barbero asignado, el cliente o nadie. */
  private async roleOn(
    userId: string,
    booking: { clientId: string; barbershopId: string; barberId: string },
  ): Promise<'BARBERSHOP' | 'BARBER' | 'CLIENT' | null> {
    if (await this.access.isMember(booking.barbershopId, userId)) return 'BARBERSHOP';
    if ((await this.barbers.barberIdsOfUser(userId)).includes(booking.barberId)) return 'BARBER';
    if (booking.clientId === userId) return 'CLIENT';
    return null;
  }

  // ───────────── RF-ATE-002: marcar atendida ─────────────

  /** El barbero asignado o la barbería, desde el inicio y hasta el cierre automático. */
  async markAttended(userId: string, bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { clientId: true, barbershopId: true, barberId: true },
    });
    if (!booking) throw notFound();
    const role = await this.roleOn(userId, booking);
    if (!role) throw notFound();
    if (role === 'CLIENT') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Solo la barbería o el barbero pueden marcar la atención.',
        HttpStatus.FORBIDDEN,
      );
    }
    const { autoCloseHours } = await this.loadSettings();
    await this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<{ status: BookingStatus; start_at: Date }[]>`
        SELECT status::text AS status, start_at FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      if (
        !attendedAllowed({
          status: current!.status,
          startAt: current!.start_at.getTime(),
          now: this.clock.now(),
          autoCloseHours,
        })
      ) {
        throw new AppException(
          ErrorCode.ATTENDANCE_NOT_ALLOWED,
          `Solo se puede marcar como atendida una reserva confirmada, desde su inicio y hasta ${autoCloseHours} horas después.`,
          HttpStatus.CONFLICT,
          [{ autoCloseHours }],
        );
      }
      await this.stateMachine.transition(tx, bookingId, 'ATTENDED', {
        userId,
        role: 'BARBERSHOP',
      });
    });
  }

  // ───────────── Corrección ATTENDED ↔ NO_SHOW ─────────────

  /** Solo OWNER o MANAGER, con motivo, dentro de `booking.attendance_correction_hours`. */
  async correct(userId: string, bookingId: string, dto: AttendanceCorrectionDto): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { clientId: true, barbershopId: true, barberId: true },
    });
    if (!booking) throw notFound();
    const role = await this.roleOn(userId, booking);
    if (!role) throw notFound();
    if (role !== 'BARBERSHOP') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Solo el responsable de la barbería puede corregir una marca de asistencia.',
        HttpStatus.FORBIDDEN,
      );
    }
    const { correctionHours } = await this.loadSettings();
    await this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<{ status: BookingStatus; start_at: Date }[]>`
        SELECT status::text AS status, start_at FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      if (
        !correctionAllowed({
          status: current!.status,
          startAt: current!.start_at.getTime(),
          now: this.clock.now(),
          correctionHours,
        })
      ) {
        throw new AppException(
          ErrorCode.ATTENDANCE_CORRECTION_NOT_ALLOWED,
          `Solo se puede corregir una reserva atendida o no asistida, hasta ${correctionHours} horas después del inicio. Después, contacta a soporte.`,
          HttpStatus.CONFLICT,
          [{ correctionHours }],
        );
      }
      const from = await this.stateMachine.correct(
        tx,
        bookingId,
        dto.status,
        { userId, role: 'BARBERSHOP' },
        dto.reason,
      );
      await this.audit.record(
        {
          actorId: userId,
          action: 'booking.attendance_corrected',
          entityType: 'booking',
          entityId: bookingId,
          changes: { values: { status: { from, to: dto.status } }, actorRole: 'BARBERSHOP' },
        },
        tx,
      );
    });
  }

  /**
   * Fase 12: corrección por soporte, sin el plazo de 48 h (con motivo). Mismo camino que la del
   * responsable: máquina de estados, historial, evento y auditoría. El conflicto de interés lo
   * comprueba quien llama.
   */
  async correctBySupport(
    staffId: string,
    staffRole: 'SUPPORT' | 'ADMIN',
    bookingId: string,
    dto: AttendanceCorrectionDto,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const from = await this.stateMachine.correct(
        tx,
        bookingId,
        dto.status,
        { userId: staffId, role: 'SUPPORT' },
        dto.reason,
      );
      await this.audit.record(
        {
          actorId: staffId,
          action: 'booking.attendance_corrected',
          entityType: 'booking',
          entityId: bookingId,
          changes: {
            values: { status: { from, to: dto.status } },
            actorRole: staffRole,
            reason: dto.reason,
          },
        },
        tx,
      );
    });
  }

  // ───────────── Cierre automático ─────────────

  /**
   * Las CONFIRMED cuyo inicio + `booking.attendance_auto_close_hours` ya pasó se cierran como
   * ATTENDED (sistema, motivo `auto_close`). `FOR UPDATE SKIP LOCKED`: varias instancias no chocan.
   * Idempotente. Devuelve cuántas cerró.
   */
  async autoCloseDue(batchSize = AUTO_CLOSE_BATCH): Promise<number> {
    const { autoCloseHours } = await this.loadSettings();
    const limit = new Date(this.clock.now() - autoCloseHours * 3600_000);
    let total = 0;
    for (;;) {
      const closed = await this.prisma.$transaction(async (tx) => {
        const due = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM bookings
           WHERE status = 'CONFIRMED' AND start_at < ${limit}
           ORDER BY start_at
           LIMIT ${batchSize}
           FOR UPDATE SKIP LOCKED`;
        for (const { id } of due) {
          await this.stateMachine.transition(tx, id, 'ATTENDED', SYSTEM_ACTOR, AUTO_CLOSE_REASON);
        }
        return due.length;
      });
      total += closed;
      if (closed < batchSize) return total;
    }
  }

  // ───────────── RF-ATE-001: agenda del día ─────────────

  /**
   * Fecha de la agenda: real (no 2030-02-30) y dentro de [hoy − 90 días, hoy + horizonte de
   * reservas], según el calendario de la barbería.
   */
  private async assertAgendaDate(date: string, timezone: string): Promise<void> {
    const parsed = DateTime.fromISO(date, { zone: timezone });
    if (!parsed.isValid || parsed.toISODate() !== date) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'date', constraints: ['isDate'] }],
      );
    }
    const { horizonDays } = await this.availability.loadSettings();
    const today = this.availability.todayIn(timezone);
    const firstDate = addDays(today, -AGENDA_PAST_DAYS);
    const lastDate = addDays(today, horizonDays);
    if (date < firstDate || date > lastDate) {
      throw new AppException(
        ErrorCode.DATE_OUT_OF_RANGE,
        `La agenda se consulta desde ${AGENDA_PAST_DAYS} días atrás hasta ${horizonDays} días adelante.`,
        HttpStatus.BAD_REQUEST,
        [{ today, firstDate, lastDate, timezone }],
      );
    }
  }

  /** Agenda del barbero: su perfil activo, en el día local de su barbería. */
  async barberAgenda(userId: string, date: string | undefined): Promise<AgendaDto> {
    const [profile] = await this.barbers.activeProfilesOfUser(userId);
    if (!profile) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No tienes un perfil de barbero activo.',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.agenda(profile.barbershopId, [profile.id], date, 'BARBER');
  }

  /** Agenda de la barbería (OWNER o MANAGER), opcionalmente de un barbero. */
  async barbershopAgenda(
    userId: string,
    barbershopId: string,
    date: string | undefined,
    barberId: string | undefined,
  ): Promise<AgendaDto> {
    await this.access.requireMember(userId, barbershopId);
    if (barberId && !(await this.barbers.findInBarbershop(barbershopId, barberId))) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El barbero no existe.', HttpStatus.NOT_FOUND);
    }
    return this.agenda(barbershopId, barberId ? [barberId] : null, date, 'BARBERSHOP');
  }

  private async agenda(
    barbershopId: string,
    barberIds: string[] | null,
    date: string | undefined,
    viewer: 'BARBER' | 'BARBERSHOP',
  ): Promise<AgendaDto> {
    const timezone = await this.access.timezoneOf(barbershopId);
    const localDate = date ?? this.availability.todayIn(timezone);
    if (date !== undefined) await this.assertAgendaDate(date, timezone);
    const day = localDayBounds(localDate, timezone);
    const range = { from: new Date(day.start), to: new Date(day.end) };
    const now = this.clock.now();
    const settings = await this.loadSettings();

    const [bookings, blocks, names] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          barbershopId,
          ...(barberIds ? { barberId: { in: barberIds } } : {}),
          startAt: { gte: range.from, lt: range.to },
          status: { in: AGENDA_STATUSES },
          // Pendientes de pago: solo las vigentes ("por confirmar").
          NOT: { status: 'PENDING_PAYMENT', expiresAt: { lte: new Date(now) } },
        },
        orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          startAt: true,
          endAt: true,
          serviceId: true,
          serviceNameSnapshot: true,
          barberId: true,
          clientId: true,
        },
      }),
      this.availability.blocksBetween(barbershopId, range),
      this.access.namesIncludingDeleted([barbershopId]),
    ]);
    const [barberNames, clientNames, categories] = await Promise.all([
      this.barbers.displayNames([...new Set(bookings.map((b) => b.barberId))]),
      this.users.fullNames([...new Set(bookings.map((b) => b.clientId))]),
      this.services.categoryKeysOf(bookings.map((b) => b.serviceId)),
    ]);

    const items = bookings.map((b) => {
      const startAt = b.startAt.getTime();
      const pendingAttention = b.status === 'CONFIRMED' && startAt <= now;
      return {
        bookingId: b.id,
        status: b.status,
        startAt: b.startAt,
        endAt: b.endAt,
        service: {
          id: b.serviceId,
          name: b.serviceNameSnapshot,
          categoryKey: categories.get(b.serviceId) ?? 'other',
        },
        barber: { id: b.barberId, name: barberNames.get(b.barberId) ?? null },
        // Solo el nombre (decisión de la Fase 7).
        client: { id: b.clientId, name: clientNames.get(b.clientId) ?? null },
        awaitingPayment: b.status === 'PENDING_PAYMENT',
        pendingAttention,
        actions: {
          canMarkAttended: attendedAllowed({
            status: b.status,
            startAt,
            now,
            autoCloseHours: settings.autoCloseHours,
          }),
          canMarkNoShow: noShowAllowed({
            status: b.status,
            startAt,
            now,
            afterMinutes: settings.noShowAfterMinutes,
            windowHours: settings.noShowWindowHours,
          }),
          canCorrect:
            viewer === 'BARBERSHOP' &&
            correctionAllowed({
              status: b.status,
              startAt,
              now,
              correctionHours: settings.correctionHours,
            }),
          // La misma regla que aplica POST /bookings/{id}/cancel a la barbería.
          canCancel:
            viewer === 'BARBERSHOP' &&
            cancellationDecision({ status: b.status, startAt, now, by: 'BARBERSHOP' }).allowed,
        },
      };
    });

    return {
      date: localDate,
      timezone,
      barbershop: { id: barbershopId, name: names.get(barbershopId) ?? null },
      items,
      // El barbero ve los bloqueos de la barbería y los suyos; el responsable, los del filtro.
      blocks: blocks
        .filter((b) => !barberIds || b.barberId === null || barberIds.includes(b.barberId))
        .map((b) => ({
          id: b.id,
          barberId: b.barberId,
          startAt: b.startAt,
          endAt: b.endAt,
          type: b.type,
          reason: b.reason,
        })),
      pendingAttention: items.filter((i) => i.pendingAttention).length,
    };
  }
}
