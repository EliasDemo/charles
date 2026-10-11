import { ANONYMIZED_NAME } from '../users/users.service';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  DEFAULT_PAGE_SIZE,
  type Page,
  type PaginationQueryDto,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { ReviewReportTarget } from '../../generated/prisma/enums';
import { BarbershopAccessService, forbidden } from '../barbershops/barbershop-access.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import type {
  BarbershopReviewsQueryDto,
  CreateReviewDto,
  CreateReviewReportDto,
  ManagedReviewDto,
  ManagedReviewsQueryDto,
  MyReviewDto,
  PublicReviewDto,
  UpdateReviewDto,
} from './dto/review.dto';
import { ReviewModerationService } from './review-moderation.service';
import { publicAuthorName, REVIEW_DEFAULTS, withinReviewWindow } from './review-policy';
import { ReviewRatings } from './review-ratings';

const reviewInclude = {
  client: { select: { fullName: true, anonymizedAt: true } },
  barber: { select: { id: true, displayName: true } },
  booking: { select: { serviceNameSnapshot: true } },
  barbershop: { select: { id: true, name: true } },
} as const;

type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof reviewInclude }>;

const reviewNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La valoración no existe.', HttpStatus.NOT_FOUND);

const bookingNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La reserva no existe.', HttpStatus.NOT_FOUND);

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Valoraciones (RF-VAL-001…003):
 * - el cliente valora una reserva propia `ATTENDED`, una sola vez, dentro del plazo
 *   (`reviews.window_days`, 14 días desde ATTENDED); puede editarla una vez en el mismo plazo y
 *   retirarla cuando quiera;
 * - la barbería (OWNER o MANAGER) responde una vez por valoración y puede editar la respuesta;
 * - cualquiera con sesión reporta la valoración o la respuesta, una vez por objetivo;
 * - los promedios se recalculan en la misma transacción (`ReviewRatings`).
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ratings: ReviewRatings,
    private readonly moderation: ReviewModerationService,
    private readonly access: BarbershopAccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Cliente ─────────────

  async create(userId: string, bookingId: string, dto: CreateReviewDto): Promise<MyReviewDto> {
    const windowDays = await this.windowDays();
    let reviewId: string;
    try {
      reviewId = await this.prisma.$transaction(async (tx) => {
        // Bloquea la reserva: dos valoraciones simultáneas de la misma reserva se serializan.
        const [booking] = await tx.$queryRaw<
          { client_id: string; status: string; barbershop_id: string; barber_id: string }[]
        >`SELECT client_id::text AS client_id, status::text AS status,
                 barbershop_id::text AS barbershop_id, barber_id::text AS barber_id
            FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
        if (!booking || booking.client_id !== userId) throw bookingNotFound();
        if (booking.status !== 'ATTENDED') {
          throw new AppException(
            ErrorCode.REVIEW_NOT_ALLOWED,
            'Solo puedes valorar una reserva en la que fuiste atendido.',
            HttpStatus.CONFLICT,
          );
        }
        const attendedAt = await this.attendedAt(tx, bookingId);
        if (!attendedAt || !withinReviewWindow(attendedAt, this.clock.now(), windowDays)) {
          throw new AppException(
            ErrorCode.REVIEW_NOT_ALLOWED,
            `El plazo para valorar esta reserva (${windowDays} días) ya terminó.`,
            HttpStatus.CONFLICT,
          );
        }
        if (await tx.review.count({ where: { bookingId } })) throw alreadyReviewed();
        const review = await tx.review.create({
          data: {
            bookingId,
            clientId: userId,
            barbershopId: booking.barbershop_id,
            barberId: booking.barber_id,
            rating: dto.rating,
            comment: dto.comment ?? null,
            createdAt: new Date(this.clock.now()),
          },
          select: { id: true },
        });
        await this.ratings.recalculate(tx, booking.barbershop_id, booking.barber_id);
        // Fase 10: aviso a la barbería.
        await this.outbox.publish(tx, 'review.created', {
          reviewId: review.id,
          barbershopId: booking.barbershop_id,
          rating: dto.rating,
        });
        return review.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw alreadyReviewed();
      throw error;
    }
    return this.mine(userId, reviewId);
  }

  async update(userId: string, reviewId: string, dto: UpdateReviewDto): Promise<MyReviewDto> {
    if (dto.rating === undefined && dto.comment === undefined) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Indica la puntuación o el comentario.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const windowDays = await this.windowDays();
    await this.prisma.$transaction(async (tx) => {
      const review = await this.moderation.lock(tx, reviewId);
      const owned = review
        ? await tx.review.findFirst({
            where: { id: reviewId, clientId: userId, deletedAt: null },
            select: { editedAt: true, rating: true },
          })
        : null;
      if (!review || !owned) throw reviewNotFound();
      const attendedAt = await this.attendedAt(tx, review.booking_id);
      if (
        owned.editedAt ||
        !attendedAt ||
        !withinReviewWindow(attendedAt, this.clock.now(), windowDays)
      ) {
        throw new AppException(
          ErrorCode.REVIEW_EDIT_NOT_ALLOWED,
          'La valoración solo se puede editar una vez y dentro del plazo.',
          HttpStatus.CONFLICT,
        );
      }
      await tx.review.update({
        where: { id: reviewId },
        data: {
          ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
          ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
          editedAt: new Date(this.clock.now()),
        },
      });
      if (dto.rating !== undefined && dto.rating !== owned.rating) {
        await this.ratings.recalculate(tx, review.barbershop_id, review.barber_id);
      }
    });
    return this.mine(userId, reviewId);
  }

  /** Retirar: borrado lógico, en cualquier momento. Recalcula los promedios. */
  async retire(userId: string, reviewId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const review = await this.moderation.lock(tx, reviewId);
      const owned = review
        ? await tx.review.count({ where: { id: reviewId, clientId: userId, deletedAt: null } })
        : 0;
      if (!review || owned === 0) throw reviewNotFound();
      await tx.review.update({ where: { id: reviewId }, data: { deletedAt: new Date() } });
      await this.ratings.recalculate(tx, review.barbershop_id, review.barber_id);
    });
  }

  async listMine(userId: string, query: PaginationQueryDto): Promise<Page<MyReviewDto>> {
    const windowDays = await this.windowDays();
    const rows = await this.prisma.review.findMany({
      where: {
        clientId: userId,
        deletedAt: null,
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: (query.limit ?? DEFAULT_PAGE_SIZE) + 1,
      include: reviewInclude,
    });
    const attended = await this.attendedAtMany(rows.map((r) => r.bookingId));
    return pageDesc(rows, query, (row) =>
      this.toMine(row, attended.get(row.bookingId), windowDays),
    );
  }

  // ───────────── Público ─────────────

  async listPublic(
    barbershopId: string,
    query: BarbershopReviewsQueryDto,
  ): Promise<Page<PublicReviewDto>> {
    await this.access.requirePublic(barbershopId);
    const rows = await this.prisma.review.findMany({
      where: {
        barbershopId,
        deletedAt: null,
        status: { not: 'HIDDEN' },
        ...(query.barberId ? { barberId: query.barberId } : {}),
        ...(query.rating ? { rating: query.rating } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: (query.limit ?? DEFAULT_PAGE_SIZE) + 1,
      include: reviewInclude,
    });
    return pageDesc(rows, query, (row) => this.toPublic(row));
  }

  // ───────────── Barbería ─────────────

  /** M9: todas las valoraciones de la barbería (también ocultas), para OWNER o MANAGER. */
  async listManaged(
    userId: string,
    barbershopId: string,
    query: ManagedReviewsQueryDto,
  ): Promise<Page<ManagedReviewDto>> {
    const membership = await this.access.requireMember(userId, barbershopId);
    const rows = await this.prisma.review.findMany({
      where: {
        barbershopId,
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.barberId ? { barberId: query.barberId } : {}),
        ...(query.rating ? { rating: query.rating } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: (query.limit ?? DEFAULT_PAGE_SIZE) + 1,
      include: reviewInclude,
    });
    const canRespond = membership.role === 'OWNER' || membership.role === 'MANAGER';
    return pageDesc(rows, query, (row) => ({
      ...this.toPublic(row),
      response:
        row.responseText !== null && row.responseAt !== null
          ? { text: row.responseText, respondedAt: row.responseAt.toISOString() }
          : null,
      status: row.status,
      responseStatus: row.responseStatus,
      canRespond,
    }));
  }

  /** Una respuesta por valoración (crear o editar), del OWNER o MANAGER. Auditada. */
  async respond(userId: string, reviewId: string, text: string): Promise<PublicReviewDto> {
    const review = await this.prisma.review.findFirst({
      where: { id: reviewId, deletedAt: null },
      select: { barbershopId: true },
    });
    if (!review) throw reviewNotFound();
    await this.access.requireMember(userId, review.barbershopId);
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.moderation.lock(tx, reviewId);
      if (!locked || locked.deleted) throw reviewNotFound();
      const editing = locked.response_status !== null;
      await tx.review.update({
        where: { id: reviewId },
        data: {
          responseText: text,
          responseById: userId,
          responseAt: new Date(this.clock.now()),
          // Editar no cambia la visibilidad decidida por soporte.
          ...(editing ? {} : { responseStatus: 'VISIBLE' }),
        },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: editing ? 'review.response_updated' : 'review.response_created',
          entityType: 'review',
          entityId: reviewId,
          changes: { barbershopId: review.barbershopId, length: text.length },
        },
        tx,
      );
    });
    const row = await this.prisma.review.findUniqueOrThrow({
      where: { id: reviewId },
      include: reviewInclude,
    });
    return this.toPublic(row);
  }

  // ───────────── Reportes ─────────────

  /**
   * Reporta la valoración o la respuesta. Una vez por usuario y objetivo. Con el umbral de
   * reportes abiertos pasa a `UNDER_REVIEW` (sigue visible) y queda en la cola de soporte.
   */
  async report(userId: string, reviewId: string, dto: CreateReviewReportDto): Promise<void> {
    const target: ReviewReportTarget = dto.target ?? 'REVIEW';
    const review = await this.prisma.review.findFirst({
      where: { id: reviewId, deletedAt: null, status: { not: 'HIDDEN' } },
      select: { clientId: true, barbershopId: true, responseStatus: true },
    });
    if (!review) throw reviewNotFound();
    if (target === 'RESPONSE' && (review.responseStatus ?? 'HIDDEN') === 'HIDDEN') {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'La valoración no tiene una respuesta visible.',
        HttpStatus.NOT_FOUND,
      );
    }
    // Nadie reporta lo propio: el autor su valoración, la barbería su respuesta.
    if (target === 'REVIEW' && review.clientId === userId) throw forbidden();
    if (target === 'RESPONSE' && (await this.access.isMember(review.barbershopId, userId))) {
      throw forbidden();
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const locked = await this.moderation.lock(tx, reviewId);
        if (!locked || locked.deleted) throw reviewNotFound();
        await tx.reviewReport.create({
          data: {
            reviewId,
            reportedById: userId,
            target,
            reason: dto.reason,
            details: dto.details ?? null,
          },
        });
        await this.moderation.applyReportThreshold(tx, locked, target);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppException(
          ErrorCode.ALREADY_REPORTED,
          'Ya reportaste este contenido.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  // ───────────── Auxiliares ─────────────

  private windowDays(): Promise<number> {
    return this.settings.positiveInt(SettingKey.REVIEWS_WINDOW_DAYS, REVIEW_DEFAULTS.windowDays);
  }

  /** Primera vez que la reserva quedó ATTENDED (una corrección posterior no reinicia el plazo). */
  private async attendedAt(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<Date | undefined> {
    const first = await tx.bookingStatusHistory.findFirst({
      where: { bookingId, toStatus: 'ATTENDED' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return first?.createdAt;
  }

  private async attendedAtMany(bookingIds: string[]): Promise<Map<string, Date>> {
    if (bookingIds.length === 0) return new Map();
    const rows = await this.prisma.bookingStatusHistory.groupBy({
      by: ['bookingId'],
      where: { bookingId: { in: bookingIds }, toStatus: 'ATTENDED' },
      _min: { createdAt: true },
    });
    return new Map(
      rows.flatMap((r) => (r._min.createdAt ? [[r.bookingId, r._min.createdAt] as const] : [])),
    );
  }

  private async mine(userId: string, reviewId: string): Promise<MyReviewDto> {
    const row = await this.prisma.review.findFirstOrThrow({
      where: { id: reviewId, clientId: userId },
      include: reviewInclude,
    });
    const attended = await this.attendedAt(this.prisma, row.bookingId);
    return this.toMine(row, attended, await this.windowDays());
  }

  private toPublic(row: ReviewRow): PublicReviewDto {
    const responseVisible =
      row.responseText !== null && row.responseAt !== null && row.responseStatus !== 'HIDDEN';
    return {
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      authorName: row.client.anonymizedAt ? ANONYMIZED_NAME : publicAuthorName(row.client.fullName),
      serviceName: row.booking.serviceNameSnapshot,
      barber: { id: row.barber.id, displayName: row.barber.displayName },
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      response: responseVisible
        ? { text: row.responseText!, respondedAt: row.responseAt!.toISOString() }
        : null,
    };
  }

  private toMine(row: ReviewRow, attendedAt: Date | undefined, windowDays: number): MyReviewDto {
    return {
      ...this.toPublic(row),
      bookingId: row.bookingId,
      barbershop: { id: row.barbershop.id, name: row.barbershop.name },
      status: row.status,
      canEdit:
        row.editedAt === null &&
        attendedAt !== undefined &&
        withinReviewWindow(attendedAt, this.clock.now(), windowDays),
    };
  }
}

const alreadyReviewed = (): AppException =>
  new AppException(
    ErrorCode.REVIEW_ALREADY_EXISTS,
    'Ya valoraste esta reserva.',
    HttpStatus.CONFLICT,
  );

/** Página ordenada por `id` descendente (UUID v7: las más recientes primero). */
function pageDesc<Row extends { id: string }, T>(
  rows: Row[],
  query: PaginationQueryDto,
  map: (row: Row) => T,
): Page<T> {
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: pageRows.map(map),
    nextCursor: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
  };
}
