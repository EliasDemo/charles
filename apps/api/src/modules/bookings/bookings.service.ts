import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { AvailabilityService } from '../availability/availability.service';
import { localDateOf, localDayBounds } from '../availability/engine/local-time';
import { BarbersService } from '../barbers/barbers.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { PaymentsService } from '../payments/payments.service';
import { ServicesService } from '../services/services.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { cancellationDecision, parseDeadline } from './booking-policy';
import { type BookingActor, BookingStateMachine } from './booking-state-machine';
import type {
  BookingDto,
  BookingListQueryDto,
  BookingPageDto,
  CancelBookingDto,
  CreateBookingDto,
  CreatedBookingDto,
} from './dto/booking.dto';

export const BOOKING_DEFAULTS = { pendingTtlMinutes: 10, maxPendingPerClient: 2 } as const;
/** "Cualquier barbero": candidatos que se intentan si otro se adelanta (CLAUDE.md §4.1). */
export const MAX_BARBER_ATTEMPTS = 3;
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
  const text = `${error instanceof Error ? error.message : ''} ${JSON.stringify(error) ?? ''}`;
  return text.includes('bookings_no_overlap');
}

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
    const now = this.clock.now();
    const endAt = startAt + service.durationMinutes * 60_000;
    const actor: BookingActor = { userId: clientId, role: 'CLIENT' };

    let created: { bookingId: string; paymentId: string } | { replayId: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
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
      });
    } catch (error) {
      // Dos peticiones con la misma clave a la vez: la segunda devuelve la reserva de la primera.
      if (isUniqueViolation(error)) {
        const again = await this.findReplay(clientId, idempotencyKey, dto);
        if (again) return { booking: again, replayed: true };
      }
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

  private async expireOverlapping(
    tx: Prisma.TransactionClient,
    barberIds: string[],
    startAt: number,
    endAt: number,
    now: number,
  ): Promise<void> {
    const due = await tx.booking.findMany({
      where: {
        barberId: { in: barberIds },
        status: 'PENDING_PAYMENT',
        expiresAt: { lte: new Date(now) },
        startAt: { lt: new Date(endAt) },
        endAt: { gt: new Date(startAt) },
      },
      select: { id: true },
    });
    for (const booking of due) {
      await this.stateMachine.transition(tx, booking.id, 'EXPIRED', {
        userId: null,
        role: 'SYSTEM',
      });
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
              create: {
                type: 'SERVICE',
                description: input.service.name,
                amount: input.service.priceAmount,
                sourceType: 'service',
                sourceId: input.dto.serviceId,
              },
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

  async cancel(userId: string, bookingId: string, dto: CancelBookingDto): Promise<BookingDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { clientId: true, barbershopId: true, barberId: true },
    });
    if (!booking) throw notFound();

    let actor: BookingActor;
    if (booking.clientId === userId) {
      actor = { userId, role: 'CLIENT' };
    } else if (await this.access.isMember(booking.barbershopId, userId)) {
      actor = { userId, role: 'BARBERSHOP' };
      if (!dto.reason) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Los datos enviados no son válidos.',
          HttpStatus.BAD_REQUEST,
          [{ field: 'reason', constraints: ['requiredForBarbershop'] }],
        );
      }
    } else if ((await this.barbers.barberIdsOfUser(userId)).includes(booking.barberId)) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'El barbero no puede cancelar reservas. Pídeselo al responsable de la barbería.',
        HttpStatus.FORBIDDEN,
      );
    } else {
      throw notFound();
    }

    const deadline = parseDeadline(
      await this.settings.get(SettingKey.CANCELLATION_DEADLINE_MINUTES),
    );
    await this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<{ status: BookingRow['status']; start_at: Date }[]>`
        SELECT status::text AS status, start_at FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const decision = cancellationDecision({
        status: current!.status,
        startAt: current!.start_at.getTime(),
        now: this.clock.now(),
        by: actor.role === 'CLIENT' ? 'CLIENT' : 'BARBERSHOP',
        deadlineMinutes: deadline,
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
              decision.reason === 'DEADLINE_PASSED'
                ? 'Ya no se puede cancelar esta reserva.'
                : 'Esta reserva ya no se puede cancelar.',
              HttpStatus.CONFLICT,
            );
      }
      await this.stateMachine.transition(tx, bookingId, 'CANCELLED', actor, dto.reason ?? null);
      await this.payments.onBookingCancelled(tx, bookingId, actor.role);
    });
    return this.toDto(await this.loadOne(bookingId), actor.role === 'CLIENT' ? 'CLIENT' : 'STAFF');
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
    const [shops, barbers, clients] = await Promise.all([
      this.access.namesIncludingDeleted(unique(bookings.map((b) => b.barbershopId))),
      this.barbers.displayNames(unique(bookings.map((b) => b.barberId))),
      viewer === 'STAFF'
        ? this.users.fullNames(unique(bookings.map((b) => b.clientId)))
        : Promise.resolve(new Map<string, string>()),
    ]);
    const money = (amount: number, currency: string) => ({ amount, currency });
    return bookings.map((b) => {
      return {
        id: b.id,
        status: b.status,
        barbershop: { id: b.barbershopId, name: shops.get(b.barbershopId) ?? null },
        service: { id: b.serviceId, name: b.serviceNameSnapshot },
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
