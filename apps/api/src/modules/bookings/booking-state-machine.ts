import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import type { Prisma } from '../../generated/prisma/client';
import type { BookingStatus } from '../../generated/prisma/enums';

/**
 * Transiciones permitidas (CLAUDE.md §8). Es la única fuente de verdad: cualquier otra lanza
 * INVALID_STATE_TRANSITION.
 */
export const BOOKING_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  PENDING_PAYMENT: ['CONFIRMED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: ['ATTENDED', 'CANCELLED', 'NO_SHOW'],
  ATTENDED: [],
  CANCELLED: [],
  NO_SHOW: [],
  EXPIRED: [],
};

/** Quién provoca el cambio. `role` distingue la devolución en la Fase 8 (cliente o barbería). */
export interface BookingActor {
  /** null = el sistema (vencimiento, resultado del pago). */
  userId: string | null;
  role: 'CLIENT' | 'BARBERSHOP' | 'SYSTEM' | 'SUPPORT';
}

export const SYSTEM_ACTOR: BookingActor = { userId: null, role: 'SYSTEM' };

/**
 * Correcciones de una marca de asistencia equivocada (Fase 9). Van aparte de las transiciones
 * normales: solo `correct()` las aplica, así el uso habitual nunca deshace un estado final.
 */
export const ATTENDANCE_CORRECTIONS: Readonly<Partial<Record<BookingStatus, BookingStatus>>> = {
  ATTENDED: 'NO_SHOW',
  NO_SHOW: 'ATTENDED',
};

export function canCorrect(from: BookingStatus, to: BookingStatus): boolean {
  return ATTENDANCE_CORRECTIONS[from] === to;
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

/** Tipo del evento de dominio de cada estado de destino. */
export const bookingEventType = (status: BookingStatus): string =>
  `booking.${status.toLowerCase()}`;

interface LockedBooking {
  status: BookingStatus;
  start_at: Date;
  barbershop_id: string;
  client_id: string;
  barber_id: string;
}

/**
 * Máquina de estados de la reserva, en un solo lugar (CLAUDE.md §8). Cada transición, en la
 * transacción que recibe: bloquea la fila, valida, actualiza, escribe el historial y publica el
 * evento de dominio en el outbox. Si algo falla, no queda nada a medias.
 */
@Injectable()
export class BookingStateMachine {
  constructor(
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Estado inicial (null → PENDING_PAYMENT): historial y evento `booking.created`. */
  async recordCreation(
    tx: Prisma.TransactionClient,
    booking: { id: string; barbershopId: string; barberId: string; clientId: string },
    actor: BookingActor,
  ): Promise<void> {
    await tx.bookingStatusHistory.create({
      data: {
        bookingId: booking.id,
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        changedById: actor.userId,
      },
    });
    await this.outbox.publish(tx, 'booking.created', {
      bookingId: booking.id,
      barbershopId: booking.barbershopId,
      barberId: booking.barberId,
      clientId: booking.clientId,
      status: 'PENDING_PAYMENT',
      actorRole: actor.role,
    });
  }

  async transition(
    tx: Prisma.TransactionClient,
    bookingId: string,
    to: BookingStatus,
    actor: BookingActor,
    reason: string | null = null,
  ): Promise<BookingStatus> {
    const [booking] = await tx.$queryRaw<LockedBooking[]>`
      SELECT status::text AS status, start_at, barbershop_id::text AS barbershop_id,
             client_id::text AS client_id, barber_id::text AS barber_id
        FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
    if (!booking) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La reserva no existe.', HttpStatus.NOT_FOUND);
    }
    const from = booking.status;
    if (!canTransition(from, to)) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'La reserva no admite este cambio en su estado actual.',
        HttpStatus.CONFLICT,
        [{ from, to }],
      );
    }
    if ((to === 'ATTENDED' || to === 'NO_SHOW') && this.clock.now() < booking.start_at.getTime()) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'Solo se puede marcar después de la hora de inicio de la reserva.',
        HttpStatus.CONFLICT,
        [{ from, to }],
      );
    }

    await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: to,
        // Quién canceló y con qué rol: la Fase 8 trata distinto la devolución (cliente o barbería).
        ...(to === 'CANCELLED'
          ? {
              cancelledById: actor.userId,
              cancelReason: reason,
              cancelledByRole: actor.role,
            }
          : {}),
      },
    });
    await tx.bookingStatusHistory.create({
      data: { bookingId, fromStatus: from, toStatus: to, changedById: actor.userId, reason },
    });
    await this.outbox.publish(tx, bookingEventType(to), {
      bookingId,
      barbershopId: booking.barbershop_id,
      barberId: booking.barber_id,
      clientId: booking.client_id,
      from,
      status: to,
      actorRole: actor.role,
    });
    return from;
  }

  /**
   * Corrige ATTENDED ↔ NO_SHOW (Fase 9). Mismo patrón que `transition`: bloquea, valida, actualiza,
   * escribe el historial (con el motivo) y publica `booking.attendance_corrected`, todo en la
   * transacción recibida. Quién puede y hasta cuándo lo decide el servicio.
   */
  async correct(
    tx: Prisma.TransactionClient,
    bookingId: string,
    to: BookingStatus,
    actor: BookingActor,
    reason: string,
  ): Promise<BookingStatus> {
    const [booking] = await tx.$queryRaw<LockedBooking[]>`
      SELECT status::text AS status, start_at, barbershop_id::text AS barbershop_id,
             client_id::text AS client_id, barber_id::text AS barber_id
        FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
    if (!booking) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La reserva no existe.', HttpStatus.NOT_FOUND);
    }
    const from = booking.status;
    if (!canCorrect(from, to)) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'Solo se puede corregir una asistencia por inasistencia o al revés.',
        HttpStatus.CONFLICT,
        [{ from, to }],
      );
    }
    await tx.booking.update({ where: { id: bookingId }, data: { status: to } });
    await tx.bookingStatusHistory.create({
      data: {
        bookingId,
        fromStatus: from,
        toStatus: to,
        changedById: actor.userId,
        reason: `correction: ${reason}`,
      },
    });
    await this.outbox.publish(tx, 'booking.attendance_corrected', {
      bookingId,
      barbershopId: booking.barbershop_id,
      barberId: booking.barber_id,
      clientId: booking.client_id,
      from,
      status: to,
      actorRole: actor.role,
    });
    return from;
  }
}
