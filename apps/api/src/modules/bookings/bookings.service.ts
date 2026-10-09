import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { dbErrorInfo, isContention, isExclusionViolation } from '../../common/errors/db-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AvailabilityService } from '../availability/availability.service';
import { localDateOf, localDayBounds } from '../availability/engine/local-time';
import { BarbersService } from '../barbers/barbers.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { PaymentsService } from '../payments/payments.service';
import { ReconciliationService } from '../payments/reconciliation';
import { ServicesService } from '../services/services.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { cancellationDecision, NO_SHOW_DEFAULTS, noShowAllowed } from './booking-policy';
import { type BookingActor, BookingStateMachine, SYSTEM_ACTOR } from './booking-state-machine';
import type { BookingStatus } from '../../generated/prisma/enums';
import type {
  AccountDeletionBookingDto,
  BookingDto,
  BookingListQueryDto,
  BookingPageDto,
  CancelBookingDto,
  CancellationPreviewDto,
  CancelledBookingDto,
  CreateBookingDto,
  CreatedBookingDto,
} from './dto/booking.dto';
import { CancellationReviewsService } from '../moderation/cancellation-reviews.service';

export const BOOKING_DEFAULTS = { pendingTtlMinutes: 10, maxPendingPerClient: 2 } as const;
/** "Cualquier barbero": candidatos que se intentan si otro se adelanta (CLAUDE.md §4.1). */
export const MAX_BARBER_ATTEMPTS = 3;
/** Comisión de Charles por reserva: sin definir, 0 hasta que se decida (CLAUDE.md §4.2). */
export const CHARLES_FEE_AMOUNT = 0;
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bookingInclude = {
  priceLines: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.BookingInclude;
type BookingRow = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

/** Cómo ve la reserva quien consulta: el cliente no recibe datos de sí mismo; el personal sí su nombre. */
type Viewer = 'CLIENT' | 'STAFF';

const slotNotAvailable = (): AppException =>
  new AppException(
    ErrorCode.SLOT_NOT_AVAILABLE,
    'Ese horario ya no está disponible. Elige otro.',
    HttpStatus.CONFLICT,
  );
const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La reserva no existe.', HttpStatus.NOT_FOUND);
const barberCannotCancel = (): AppException =>
  new AppException(
    ErrorCode.FORBIDDEN,
    'El barbero no puede cancelar reservas. Pídeselo al responsable de la barbería.',
    HttpStatus.FORBIDDEN,
  );

/** Datos de la petición que identifican una reserva idempotente. */
function fingerprint(clientId: string, dto: CreateBookingDto): Prisma.InputJsonObject {
  return {
    clientId,
    barbershopId: dto.barbershopId,
    serviceId: dto.serviceId,
    startAt: dto.startAt.toISOString(),
    barberId: dto.barberId ?? null,
  };
}

/** Compara campo a campo (jsonb no conserva el orden de las claves). */
function sameRequest(stored: unknown, current: Prisma.InputJsonObject): boolean {
  if (typeof stored !== 'object' || stored === null) return false;
  const record = stored as Record<string, unknown>;
  return Object.keys(current).every((key) => record[key] === current[key]);
}

function isOverlapViolation(error: unknown): boolean {
  if (isExclusionViolation(dbErrorInfo(error))) return true;
  const text = `${error instanceof Error ? error.message : ''} ${JSON.stringify(error) ?? ''}`;
  return text.includes('bookings_no_overlap');
}

/**
 * Plazos de la transacción de creación. Los valores por defecto de Prisma (2 s para obtener
 * conexión y 5 s de duración) se agotan bajo carga, cuando la petición perdedora de una carrera
 * espera el bloqueo de la ganadora.
 */
export const BOOKING_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/** Espera máxima de un bloqueo dentro de la transacción de creación (SQLSTATE 55P03 si se excede). */
export const LOCK_TIMEOUT_MS = 5_000;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * "Cualquier barbero" (decisión de la Fase 7): el libre con menos reservas activas ese día; a
 * igualdad, por ID. Función pura.
 */
export function orderByLoad(candidates: string[], activeCount: Map<string, number>): string[] {
  return [...candidates].sort(
    (a, b) => (activeCount.get(a) ?? 0) - (activeCount.get(b) ?? 0) || a.localeCompare(b),
  );
}

/**
 * Reservas (RF-RES-001…008). Toda transición de estado pasa por `BookingStateMachine`; las
 * llamadas a la pasarela ocurren fuera de las transacciones (CLAUDE.md §1).
 */
@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: BookingStateMachine,
    private readonly availability: AvailabilityService,
    private readonly payments: PaymentsService,
    private readonly services: ServicesService,
    private readonly barbers: BarbersService,
    private readonly access: BarbershopAccessService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
    private readonly reviews: CancellationReviewsService,
    private readonly reconciliation: ReconciliationService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Crear (RF-RES-001/002, RF-RES-007) ─────────────

  async create(
    clientId: string,
    idempotencyKey: string | undefined,
    dto: CreateBookingDto,
  ): Promise<{ booking: CreatedBookingDto; replayed: boolean }> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'Falta la cabecera Idempotency-Key (UUID).',
        HttpStatus.BAD_REQUEST,
      );
    }
    const replay = await this.findReplay(clientId, idempotencyKey, dto);
    if (replay) return { booking: replay, replayed: true };

    const credentials = await this.users.findCredentialsById(clientId);
    if (!credentials?.emailVerified) {
      throw new AppException(
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Verifica tu correo antes de reservar.',
        HttpStatus.FORBIDDEN,
      );
    }

    const startAt = dto.startAt.getTime();
    const candidates = await this.candidateBarbers(dto, startAt);
    const service = (await this.services.bookableSummaries([dto.serviceId])).get(dto.serviceId);
    if (!service) throw slotNotAvailable();

    const [ttlMinutes, maxPending] = await Promise.all([
      this.settings.positiveInt(
        SettingKey.PENDING_PAYMENT_TTL_MINUTES,
        BOOKING_DEFAULTS.pendingTtlMinutes,
      ),
      this.settings.positiveInt(
        SettingKey.BOOKING_MAX_PENDING_PER_CLIENT,
        BOOKING_DEFAULTS.maxPendingPerClient,
      ),
    ]);
    const endAt = startAt + service.durationMinutes * 60_000;
    // Ajuste C: antes de vencer una PENDING_PAYMENT con pago iniciado, se consulta la pasarela
    // (fuera de la transacción). Si estaba pagada, se confirma en lugar de vencer.
    await this.checkStartedPaymentsBeforeExpiring(candidates, startAt, endAt);
    const now = this.clock.now();
    const actor: BookingActor = { userId: clientId, role: 'CLIENT' };

    let created: { bookingId: string; paymentId: string } | { replayId: string };
    try {
      created = await this.withContentionRetry(() =>
        this.prisma.$transaction(async (tx) => {
          // Una espera de bloqueo nunca retiene la transacción más de LOCK_TIMEOUT_MS (55P03).
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
          // Orden de bloqueos (siempre el mismo, sin ciclos): 1) cliente (consultivo);
          // 2) reservas vencidas que se solapan, por id; 3) inserción (restricción de exclusión).
          // Serializa las reservas de un mismo cliente (límite de pendientes e idempotencia).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking-client:${clientId}`}))`;
          const existing = await tx.booking.findUnique({
            where: { clientId_idempotencyKey: { clientId, idempotencyKey } },
            select: { id: true },
          });
          if (existing) return { replayId: existing.id };

          const pending = await tx.booking.count({
            where: { clientId, status: 'PENDING_PAYMENT', expiresAt: { gt: new Date(now) } },
          });
          if (pending >= maxPending) {
            throw new AppException(
              ErrorCode.TOO_MANY_PENDING_BOOKINGS,
              `Tienes ${pending} reservas pendientes de pago. Paga o cancela alguna antes de reservar otra.`,
              HttpStatus.CONFLICT,
              [{ maxPending }],
            );
          }

          // Requisito de la Fase 5: una PENDING_PAYMENT vencida aún ocupa el turno en la
          // restricción de exclusión hasta marcarse EXPIRED. Se expira aquí, en esta transacción.
          await this.expireOverlapping(tx, candidates, startAt, endAt, now);

          const bookingId = await this.insertWithFirstFreeBarber(tx, candidates, {
            clientId,
            dto,
            idempotencyKey,
            startAt,
            endAt,
            service,
            expiresAt: now + ttlMinutes * 60_000,
          });
          await this.stateMachine.recordCreation(
            tx,
            {
              id: bookingId.id,
              barbershopId: dto.barbershopId,
              barberId: bookingId.barberId,
              clientId,
            },
            actor,
          );
          const paymentId = await this.payments.createPendingInTx(tx, {
            id: bookingId.id,
            totalAmount: service.priceAmount,
            currency: service.currency,
          });
          return { bookingId: bookingId.id, paymentId };
        }, BOOKING_TX_OPTIONS),
      );
    } catch (error) {
      // Dos peticiones con la misma clave a la vez: la segunda devuelve la reserva de la primera.
      if (isUniqueViolation(error)) {
        const again = await this.findReplay(clientId, idempotencyKey, dto);
        if (again) return { booking: again, replayed: true };
      }
      const info = dbErrorInfo(error);
      // Contención que persistió tras el reintento: 503 reintentable (misma Idempotency-Key).
      if (isContention(info)) {
        throw new AppException(
          ErrorCode.SERVICE_UNAVAILABLE,
          'Hay mucha demanda en este momento. Inténtalo de nuevo en unos segundos.',
          HttpStatus.SERVICE_UNAVAILABLE,
          [{ retryable: true }],
        );
      }
      // La restricción de exclusión fuera del recorrido de candidatos sigue siendo 409.
      if (isExclusionViolation(info)) throw slotNotAvailable();
      throw error;
    }

    if ('replayId' in created) {
      const again = await this.findReplay(clientId, idempotencyKey, dto);
      if (again) return { booking: again, replayed: true };
      throw slotNotAvailable();
    }
    // Fuera de la transacción: la llamada a la pasarela (reintentable si falla).
    const payment = await this.payments.startAfterCreation(created.paymentId, service.name);
    const booking = await this.loadOne(created.bookingId);
    return { booking: { ...(await this.toDto(booking, 'CLIENT')), payment }, replayed: false };
  }

  /**
   * Ejecuta la transacción y, si falla por contención de la base (bloqueo mutuo 40P01,
   * serialización 40001, espera de bloqueo 55P03, o los equivalentes de Prisma), la reintenta una
   * vez. Si vuelve a fallar, el error sube y se responde 503 reintentable.
   */
  private async withContentionRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const info = dbErrorInfo(error);
      if (!isContention(info)) throw error;
      this.logger.warn(
        `Contención al crear una reserva (prisma=${info?.prismaCode ?? '-'}, pg=${info?.pgCode ?? '-'}); se reintenta una vez`,
      );
      return run();
    }
  }

  /**
   * Valida el turno con el motor de la Fase 5 (E: futuro, anticipación mínima y coincidencia
   * exacta con un turno ofrecido) y devuelve los barberos candidatos en orden de asignación.
   */
  private async candidateBarbers(dto: CreateBookingDto, startAt: number): Promise<string[]> {
    if (startAt <= this.clock.now()) throw slotNotAvailable();
    const info = (await this.access.publicScheduleInfo([dto.barbershopId])).get(dto.barbershopId);
    if (!info) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La barbería no existe.', HttpStatus.NOT_FOUND);
    }
    const localDate = localDateOf(startAt, info.timezone);
    let slots;
    try {
      ({ slots } = await this.availability.slotsForDate(
        { barbershopId: dto.barbershopId, serviceId: dto.serviceId, barberId: dto.barberId },
        localDate,
      ));
    } catch (error) {
      // Fecha pasada o fuera del horizonte: el turno no está disponible.
      if (error instanceof AppException && error.code === ErrorCode.DATE_OUT_OF_RANGE) {
        throw slotNotAvailable();
      }
      throw error;
    }
    const slot = slots.find((s) => s.start === startAt);
    if (!slot) throw slotNotAvailable();
    if (dto.barberId) return [dto.barberId];

    const day = localDayBounds(localDate, info.timezone);
    const load = await this.prisma.booking.groupBy({
      by: ['barberId'],
      where: {
        barberId: { in: slot.barberIds },
        startAt: { gte: new Date(day.start), lt: new Date(day.end) },
        OR: [
          { status: 'CONFIRMED' },
          { status: 'PENDING_PAYMENT', expiresAt: { gt: new Date(this.clock.now()) } },
        ],
      },
      _count: { _all: true },
    });
    const counts = new Map(load.map((l) => [l.barberId, l._count._all]));
    return orderByLoad(slot.barberIds, counts).slice(0, MAX_BARBER_ATTEMPTS);
  }

  private async checkStartedPaymentsBeforeExpiring(
    barberIds: string[],
    startAt: number,
    endAt: number,
  ): Promise<void> {
    const due = await this.prisma.payment.findMany({
      where: {
        status: 'PENDING',
        startedAt: { not: null },
        booking: {
          barberId: { in: barberIds },
          status: 'PENDING_PAYMENT',
          expiresAt: { lte: new Date(this.clock.now()) },
          startAt: { lt: new Date(endAt) },
          endAt: { gt: new Date(startAt) },
        },
      },
      select: { id: true },
    });
    for (const payment of due) await this.reconciliation.checkPayment(payment.id);
  }

  /**
   * Vence, dentro de la transacción, las PENDING_PAYMENT vencidas que se solapan con el turno.
   * Las bloquea en una sola consulta, **ordenadas por id** (orden fijo: sin bloqueos mutuos entre
   * dos creaciones que vencen las mismas reservas). Tras esperar un bloqueo, PostgreSQL vuelve a
   * evaluar la condición: las que otra transacción ya venció no se devuelven.
   */
  private async expireOverlapping(
    tx: Prisma.TransactionClient,
    barberIds: string[],
    startAt: number,
    endAt: number,
    now: number,
  ): Promise<void> {
    if (barberIds.length === 0) return;
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM bookings
       WHERE barber_id = ANY(${barberIds}::uuid[])
         AND status = 'PENDING_PAYMENT'
         AND expires_at <= ${new Date(now)}
         AND start_at < ${new Date(endAt)}
         AND end_at > ${new Date(startAt)}
       ORDER BY id
       FOR UPDATE`;
    for (const booking of due) {
      await this.stateMachine.transition(tx, booking.id, 'EXPIRED', SYSTEM_ACTOR);
    }
  }

  /**
   * Inserta con el primer barbero libre. Si la restricción de exclusión rechaza a uno (otra
   * petición se adelantó), vuelve al savepoint y prueba el siguiente. La base es la garantía
   * final contra la doble reserva (CLAUDE.md §7.3).
   */
  private async insertWithFirstFreeBarber(
    tx: Prisma.TransactionClient,
    candidates: string[],
    input: {
      clientId: string;
      dto: CreateBookingDto;
      idempotencyKey: string;
      startAt: number;
      endAt: number;
      service: { name: string; durationMinutes: number; priceAmount: number; currency: string };
      expiresAt: number;
    },
  ): Promise<{ id: string; barberId: string }> {
    for (const barberId of candidates) {
      await tx.$executeRawUnsafe('SAVEPOINT booking_insert');
      try {
        const booking = await tx.booking.create({
          data: {
            clientId: input.clientId,
            barbershopId: input.dto.barbershopId,
            barberId,
            serviceId: input.dto.serviceId,
            startAt: new Date(input.startAt),
            endAt: new Date(input.endAt),
            status: 'PENDING_PAYMENT',
            barberChosenByClient: !!input.dto.barberId,
            serviceNameSnapshot: input.service.name,
            durationMinutesSnapshot: input.service.durationMinutes,
            subtotalAmount: input.service.priceAmount,
            totalAmount: input.service.priceAmount,
            currency: input.service.currency,
            expiresAt: new Date(input.expiresAt),
            idempotencyKey: input.idempotencyKey,
            metadata: { request: fingerprint(input.clientId, input.dto) },
            // Precio congelado al reservar (RF-SER-002): los cambios del servicio no lo alteran.
            priceLines: {
              create: [
                {
                  type: 'SERVICE',
                  description: input.service.name,
                  amount: input.service.priceAmount,
                  sourceType: 'service',
                  sourceId: input.dto.serviceId,
                },
                // Comisión de Charles: sin definir (CLAUDE.md §4.2). El cálculo queda preparado
                // como línea FEE en 0; fee_total_amount y total no cambian.
                {
                  type: 'FEE',
                  description: 'Comisión de Charles',
                  amount: CHARLES_FEE_AMOUNT,
                  sourceType: 'commission',
                },
              ],
            },
          },
          select: { id: true },
        });
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT booking_insert');
        return { id: booking.id, barberId };
      } catch (error) {
        if (!isOverlapViolation(error)) throw error;
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT booking_insert');
      }
    }
    throw slotNotAvailable();
  }

  /** Reserva previa con la misma clave: la misma petición la devuelve; otra distinta es 409. */
  private async findReplay(
    clientId: string,
    idempotencyKey: string,
    dto: CreateBookingDto,
  ): Promise<CreatedBookingDto | null> {
    const existing = await this.prisma.booking.findUnique({
      where: { clientId_idempotencyKey: { clientId, idempotencyKey } },
      include: bookingInclude,
    });
    if (!existing) return null;
    if (
      !sameRequest((existing.metadata as { request?: unknown }).request, fingerprint(clientId, dto))
    ) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'Esa clave de idempotencia ya se usó con otra reserva.',
        HttpStatus.CONFLICT,
      );
    }
    const payment = await this.prisma.payment.findFirst({
      where: { bookingId: existing.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...(await this.toDto(existing, 'CLIENT')),
      payment: {
        paymentId: payment?.id ?? '',
        provider: payment?.provider ?? '',
        status: payment?.status ?? 'PENDING',
        amount: { amount: existing.totalAmount, currency: existing.currency },
        clientAction: null,
      },
    };
  }

  // ───────────── Cancelar (RF-RES-005) ─────────────

  /** Quién actúa sobre la reserva: el cliente, la barbería (OWNER/MANAGER) o el barbero asignado. */
  private async actorOn(
    userId: string,
    booking: { clientId: string; barbershopId: string; barberId: string },
  ): Promise<'CLIENT' | 'BARBERSHOP' | 'BARBER' | null> {
    if (booking.clientId === userId) return 'CLIENT';
    if (await this.access.isMember(booking.barbershopId, userId)) return 'BARBERSHOP';
    if ((await this.barbers.barberIdsOfUser(userId)).includes(booking.barberId)) return 'BARBER';
    return null;
  }

  /**
   * Vista previa (Fase 8A): si se puede cancelar ahora y cuánto se devolvería. Usa la misma
   * función que la cancelación, así lo que ve el cliente es lo que se aplica.
   */
  // ───────────── Eliminación de cuenta ─────────────

  /** Reservas del cliente que se cancelarían ahora (activas y aún no empezadas). */
  private async cancellableForClient(
    clientId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<
    { id: string; status: BookingStatus; startAt: Date; currency: string; barbershopId: string }[]
  > {
    const now = this.clock.now();
    const rows = await tx.booking.findMany({
      where: { clientId, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
      select: { id: true, status: true, startAt: true, currency: true, barbershopId: true },
      orderBy: { id: 'asc' },
    });
    return rows.filter(
      (b) =>
        cancellationDecision({ status: b.status, startAt: b.startAt.getTime(), now, by: 'CLIENT' })
          .allowed,
    );
  }

  /**
   * Vista previa para eliminar la cuenta: qué reservas se cancelarán y cuánto se devuelve por
   * cada una, con la **misma** política que la vista previa de cancelación del cliente.
   */
  async previewForAccountDeletion(clientId: string): Promise<AccountDeletionBookingDto[]> {
    const bookings = await this.cancellableForClient(clientId);
    const shops = await this.access.basicsIncludingDeleted([
      ...new Set(bookings.map((b) => b.barbershopId)),
    ]);
    const items: AccountDeletionBookingDto[] = [];
    for (const b of bookings) {
      const quote = await this.payments.quoteCancellation(
        { id: b.id, startAt: b.startAt },
        'CLIENT',
      );
      items.push({
        bookingId: b.id,
        status: b.status,
        startAt: b.startAt,
        barbershop: {
          id: b.barbershopId,
          name: shops.get(b.barbershopId)?.name ?? null,
          timezone: shops.get(b.barbershopId)?.timezone ?? 'America/Lima',
        },
        refund: {
          amount: { amount: quote.amount, currency: b.currency },
          percent: quote.percent,
          rule: quote.rule,
          paid: { amount: quote.refundableAmount, currency: b.currency },
        },
      });
    }
    return items;
  }

  /**
   * Al confirmar la eliminación de la cuenta (en su transacción): cancela sus reservas activas
   * como **cancelación del cliente**, con la política de devolución normal. Bloquea en orden de id.
   */
  async cancelForAccountDeletionInTx(
    tx: Prisma.TransactionClient,
    clientId: string,
  ): Promise<string[]> {
    const ids = (await this.cancellableForClient(clientId, tx)).map((b) => b.id);
    const cancelled: string[] = [];
    for (const id of ids) {
      const [current] = await tx.$queryRaw<{ status: BookingStatus; start_at: Date }[]>`
        SELECT status::text AS status, start_at FROM bookings WHERE id = ${id}::uuid FOR UPDATE`;
      if (
        !current ||
        !cancellationDecision({
          status: current.status,
          startAt: current.start_at.getTime(),
          now: this.clock.now(),
          by: 'CLIENT',
        }).allowed
      ) {
        continue;
      }
      await this.stateMachine.transition(
        tx,
        id,
        'CANCELLED',
        { userId: clientId, role: 'CLIENT' },
        'account_deletion',
      );
      await this.payments.onBookingCancelled(tx, { id, startAt: current.start_at }, 'CLIENT');
      cancelled.push(id);
    }
    return cancelled;
  }

  async cancellationPreview(userId: string, bookingId: string): Promise<CancellationPreviewDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        clientId: true,
        barbershopId: true,
        barberId: true,
        status: true,
        startAt: true,
        currency: true,
      },
    });
    if (!booking) throw notFound();
    const role = await this.actorOn(userId, booking);
    if (!role) throw notFound();
    if (role === 'BARBER') throw barberCannotCancel();
    const by = role === 'CLIENT' ? 'CLIENT' : 'BARBERSHOP';
    const decision = cancellationDecision({
      status: booking.status,
      startAt: booking.startAt.getTime(),
      now: this.clock.now(),
      by,
    });
    const quote = await this.payments.quoteCancellation(
      { id: bookingId, startAt: booking.startAt },
      by,
    );
    return {
      allowed: decision.allowed,
      reason: decision.allowed ? null : decision.reason,
      refund: {
        amount: { amount: decision.allowed ? quote.amount : 0, currency: booking.currency },
        percent: decision.allowed ? quote.percent : 0,
        rule: quote.rule,
        paid: { amount: quote.refundableAmount, currency: booking.currency },
      },
      reasonRequired: by === 'BARBERSHOP',
    };
  }

  async cancel(
    userId: string,
    bookingId: string,
    dto: CancelBookingDto,
  ): Promise<CancelledBookingDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { clientId: true, barbershopId: true, barberId: true, startAt: true },
    });
    if (!booking) throw notFound();
    const role = await this.actorOn(userId, booking);
    if (!role) throw notFound();
    if (role === 'BARBER') throw barberCannotCancel();
    const actor: BookingActor = { userId, role };
    if (role === 'BARBERSHOP' && !dto.reason) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'reason', constraints: ['requiredForBarbershop'] }],
      );
    }

    const quote = await this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<{ status: BookingRow['status']; start_at: Date }[]>`
        SELECT status::text AS status, start_at FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const decision = cancellationDecision({
        status: current!.status,
        startAt: current!.start_at.getTime(),
        now: this.clock.now(),
        by: role,
      });
      if (!decision.allowed) {
        throw decision.reason === 'ALREADY_CANCELLED'
          ? new AppException(
              ErrorCode.ALREADY_CANCELLED,
              'La reserva ya estaba cancelada.',
              HttpStatus.CONFLICT,
            )
          : new AppException(
              ErrorCode.CANCELLATION_NOT_ALLOWED,
              decision.reason === 'ALREADY_STARTED'
                ? 'La reserva ya empezó; ya no se puede cancelar.'
                : 'Esta reserva ya no se puede cancelar.',
              HttpStatus.CONFLICT,
            );
      }
      await this.stateMachine.transition(tx, bookingId, 'CANCELLED', actor, dto.reason ?? null);
      // Toda cancelación de la barbería queda registrada para revisión (sanción), pagada o no.
      if (role === 'BARBERSHOP') {
        await this.reviews.recordInTx(tx, {
          bookingId,
          barbershopId: booking.barbershopId,
          cancelledById: userId,
          reason: dto.reason!,
        });
      }
      return this.payments.onBookingCancelled(
        tx,
        { id: bookingId, startAt: booking.startAt },
        role,
      );
    });
    const dtoOut = await this.toDto(
      await this.loadOne(bookingId),
      role === 'CLIENT' ? 'CLIENT' : 'STAFF',
    );
    return {
      ...dtoOut,
      refund: {
        amount: { amount: quote.amount, currency: dtoOut.price.total.currency },
        percent: quote.percent,
        rule: quote.rule,
        paid: { amount: quote.refundableAmount, currency: dtoOut.price.total.currency },
      },
    };
  }

  /**
   * Inasistencia (Fase 8A): el barbero asignado o la barbería, desde
   * `booking.no_show_after_minutes` (15) y hasta `booking.no_show_window_hours` (24) después del
   * inicio. Sin devolución.
   */
  async markNoShow(userId: string, bookingId: string): Promise<BookingDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { clientId: true, barbershopId: true, barberId: true },
    });
    if (!booking) throw notFound();
    const role = await this.actorOn(userId, booking);
    if (!role) throw notFound();
    if (role === 'CLIENT') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Solo la barbería o el barbero pueden marcar una inasistencia.',
        HttpStatus.FORBIDDEN,
      );
    }
    const [afterMinutes, windowHours] = await Promise.all([
      this.settings.positiveInt(SettingKey.NO_SHOW_AFTER_MINUTES, NO_SHOW_DEFAULTS.afterMinutes),
      this.settings.positiveInt(SettingKey.NO_SHOW_WINDOW_HOURS, NO_SHOW_DEFAULTS.windowHours),
    ]);
    await this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<{ status: BookingRow['status']; start_at: Date }[]>`
        SELECT status::text AS status, start_at FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const allowed = noShowAllowed({
        status: current!.status,
        startAt: current!.start_at.getTime(),
        now: this.clock.now(),
        afterMinutes,
        windowHours,
      });
      if (!allowed) {
        throw new AppException(
          ErrorCode.NO_SHOW_NOT_ALLOWED,
          `Solo se puede marcar una inasistencia de una reserva confirmada, desde ${afterMinutes} minutos y hasta ${windowHours} horas después del inicio.`,
          HttpStatus.CONFLICT,
          [{ afterMinutes, windowHours }],
        );
      }
      await this.stateMachine.transition(tx, bookingId, 'NO_SHOW', {
        userId,
        role: 'BARBERSHOP',
      });
    });
    return this.toDto(await this.loadOne(bookingId), 'STAFF');
  }

  // ───────────── Consultar (RF-RES-004/008) ─────────────

  /** Detalle: el cliente de la reserva, la barbería (responsables) o el barbero asignado. */
  async findOne(userId: string, bookingId: string): Promise<BookingDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: bookingInclude,
    });
    if (!booking) throw notFound();
    if (booking.clientId === userId) return this.toDto(booking, 'CLIENT');
    const staff =
      (await this.access.isMember(booking.barbershopId, userId)) ||
      (await this.barbers.barberIdsOfUser(userId)).includes(booking.barberId);
    if (!staff) throw notFound();
    return this.toDto(booking, 'STAFF');
  }

  listMine(clientId: string, query: BookingListQueryDto): Promise<BookingPageDto> {
    return this.list({ clientId }, query, 'CLIENT');
  }

  async listForBarber(userId: string, query: BookingListQueryDto): Promise<BookingPageDto> {
    const barberIds = await this.barbers.barberIdsOfUser(userId);
    return this.list({ barberId: { in: barberIds } }, query, 'STAFF');
  }

  async listForBarbershop(
    userId: string,
    barbershopId: string,
    query: BookingListQueryDto,
  ): Promise<BookingPageDto> {
    await this.access.requireMember(userId, barbershopId);
    return this.list({ barbershopId }, query, 'STAFF');
  }

  /**
   * upcoming: activas (CONFIRMED o PENDING_PAYMENT vigente) que no empezaron, por inicio
   * ascendente. history: el resto, la más reciente primero. Cursor (inicio, id).
   */
  private async list(
    owner: Prisma.BookingWhereInput,
    query: BookingListQueryDto,
    viewer: Viewer,
  ): Promise<BookingPageDto> {
    const now = new Date(this.clock.now());
    const limit = query.limit ?? 20;
    const upcoming = (query.scope ?? 'upcoming') === 'upcoming';
    const activeUpcoming: Prisma.BookingWhereInput = {
      startAt: { gt: now },
      OR: [{ status: 'CONFIRMED' }, { status: 'PENDING_PAYMENT', expiresAt: { gt: now } }],
    };
    const scope = upcoming ? activeUpcoming : { NOT: activeUpcoming };
    const after = query.cursor ? decodeListCursor(query.cursor) : null;
    const keyset: Prisma.BookingWhereInput = after
      ? {
          OR: [
            { startAt: upcoming ? { gt: after.startAt } : { lt: after.startAt } },
            { startAt: after.startAt, id: upcoming ? { gt: after.id } : { lt: after.id } },
          ],
        }
      : {};
    const direction = upcoming ? 'asc' : 'desc';
    const rows = await this.prisma.booking.findMany({
      where: { AND: [owner, scope, keyset] },
      orderBy: [{ startAt: direction }, { id: direction }],
      take: limit + 1,
      include: bookingInclude,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.toDtos(page, viewer),
      nextCursor: rows.length > limit && last ? encodeListCursor(last.startAt, last.id) : null,
    };
  }

  // ───────────── Respuesta ─────────────

  private loadOne(id: string): Promise<BookingRow> {
    return this.prisma.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
  }

  private async toDto(booking: BookingRow, viewer: Viewer): Promise<BookingDto> {
    return (await this.toDtos([booking], viewer))[0]!;
  }

  private async toDtos(bookings: BookingRow[], viewer: Viewer): Promise<BookingDto[]> {
    const unique = <T>(values: T[]) => [...new Set(values)];
    const [shops, barbers, clients, categories] = await Promise.all([
      this.access.basicsIncludingDeleted(unique(bookings.map((b) => b.barbershopId))),
      this.barbers.displayNames(unique(bookings.map((b) => b.barberId))),
      viewer === 'STAFF'
        ? this.users.fullNames(unique(bookings.map((b) => b.clientId)))
        : Promise.resolve(new Map<string, string>()),
      this.services.categoryKeysOf(unique(bookings.map((b) => b.serviceId))),
    ]);
    const money = (amount: number, currency: string) => ({ amount, currency });
    return bookings.map((b) => {
      return {
        id: b.id,
        status: b.status,
        barbershop: {
          id: b.barbershopId,
          name: shops.get(b.barbershopId)?.name ?? null,
          timezone: shops.get(b.barbershopId)?.timezone ?? 'America/Lima',
        },
        service: {
          id: b.serviceId,
          name: b.serviceNameSnapshot,
          categoryKey: categories.get(b.serviceId) ?? 'other',
        },
        barber: { id: b.barberId, name: barbers.get(b.barberId) ?? null },
        barberChosenByClient: b.barberChosenByClient,
        // Solo el nombre: nunca teléfono, correo ni documento (decisión de la Fase 7).
        client:
          viewer === 'STAFF' ? { id: b.clientId, name: clients.get(b.clientId) ?? null } : null,
        startAt: b.startAt,
        endAt: b.endAt,
        durationMinutes: b.durationMinutesSnapshot,
        price: {
          subtotal: money(b.subtotalAmount, b.currency),
          discountTotal: money(b.discountTotalAmount, b.currency),
          feeTotal: money(b.feeTotalAmount, b.currency),
          total: money(b.totalAmount, b.currency),
          lines: b.priceLines.map((l) => ({
            type: l.type,
            description: l.description,
            amount: money(l.amount, b.currency),
          })),
        },
        expiresAt: b.status === 'PENDING_PAYMENT' ? b.expiresAt : null,
        cancellation:
          b.status === 'CANCELLED'
            ? { byRole: b.cancelledByRole ?? 'SYSTEM', reason: b.cancelReason }
            : null,
        createdAt: b.createdAt,
      };
    });
  }
}

function encodeListCursor(startAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([startAt.getTime(), id])).toString('base64url');
}

function decodeListCursor(cursor: string): { startAt: Date; id: string } {
  try {
    const [ms, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (typeof ms === 'number' && typeof id === 'string' && IDEMPOTENCY_KEY.test(id)) {
      return { startAt: new Date(ms), id };
    }
  } catch {
    // cae al error de abajo
  }
  throw new AppException(
    ErrorCode.INVALID_CURSOR,
    'El cursor no es válido. Vuelve a la primera página.',
    HttpStatus.BAD_REQUEST,
  );
}
