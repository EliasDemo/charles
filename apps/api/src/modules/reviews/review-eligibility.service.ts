import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { REVIEW_DEFAULTS, withinReviewWindow } from './review-policy';

/** Valoración propia de una reserva, en forma resumida (para `BookingDto.review`). */
export interface OwnReviewSummary {
  id: string;
  rating: number;
  canEdit: boolean;
}

export interface ReviewEligibility {
  canReview: boolean;
  review: OwnReviewSummary | null;
}

export const NOT_REVIEWABLE: ReviewEligibility = { canReview: false, review: null };

/**
 * Si el cliente puede valorar sus reservas (para la app, que no deduce la regla). Misma regla que
 * `POST /bookings/{id}/review`: reserva ATTENDED, sin valoración (ni retirada: una por reserva) y
 * dentro de `reviews.window_days` desde la primera vez que quedó ATTENDED. Por lotes.
 */
@Injectable()
export class ReviewEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async forClient(
    clientId: string,
    bookings: { id: string; clientId: string; status: string }[],
  ): Promise<Map<string, ReviewEligibility>> {
    const result = new Map<string, ReviewEligibility>();
    const own = bookings.filter((b) => b.clientId === clientId && b.status === 'ATTENDED');
    if (own.length === 0) return result;
    const ids = own.map((b) => b.id);
    const [windowDays, attended, reviews] = await Promise.all([
      this.windowDays(),
      this.attendedAtMany(ids),
      this.prisma.review.findMany({
        where: { bookingId: { in: ids } },
        select: { id: true, bookingId: true, rating: true, editedAt: true, deletedAt: true },
      }),
    ]);
    const byBooking = new Map(reviews.map((r) => [r.bookingId, r]));
    const now = this.clock.now();
    for (const id of ids) {
      const attendedAt = attended.get(id);
      const inWindow = attendedAt !== undefined && withinReviewWindow(attendedAt, now, windowDays);
      const review = byBooking.get(id);
      result.set(id, {
        canReview: inWindow && !review,
        review:
          review && !review.deletedAt
            ? {
                id: review.id,
                rating: review.rating,
                canEdit: inWindow && review.editedAt === null,
              }
            : null,
      });
    }
    return result;
  }

  /** Ids de las reservas que el cliente puede valorar ahora, de la más reciente a la más antigua. */
  async pendingBookingIds(clientId: string, limit: number): Promise<string[]> {
    const windowDays = await this.windowDays();
    const now = this.clock.now();
    const cutoff = new Date(now - windowDays * 24 * 3600 * 1000);
    // Candidatas: alguna marca ATTENDED dentro del plazo; el plazo exacto (primera marca) se
    // comprueba después, porque una corrección posterior no lo reinicia.
    const candidates = await this.prisma.booking.findMany({
      where: {
        clientId,
        status: 'ATTENDED',
        review: null,
        statusHistory: { some: { toStatus: 'ATTENDED', createdAt: { gte: cutoff } } },
      },
      orderBy: [{ startAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
      take: limit * 2,
    });
    const attended = await this.attendedAtMany(candidates.map((c) => c.id));
    return candidates
      .filter((c) => {
        const at = attended.get(c.id);
        return at !== undefined && withinReviewWindow(at, now, windowDays);
      })
      .slice(0, limit)
      .map((c) => c.id);
  }

  private windowDays(): Promise<number> {
    return this.settings.positiveInt(SettingKey.REVIEWS_WINDOW_DAYS, REVIEW_DEFAULTS.windowDays);
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
}
