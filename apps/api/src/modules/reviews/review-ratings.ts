import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

interface RatingRow {
  rating_avg: string;
  rating_count: number;
}

export interface RatingChange {
  before: { average: number; count: number };
  after: { average: number; count: number };
}

const toRating = (row: RatingRow | undefined) => ({
  average: Number(row?.rating_avg ?? 0),
  count: row?.rating_count ?? 0,
});

/**
 * Promedios de valoraciones (RF-VAL-003): barbería y barbero. Siempre con una consulta agregada
 * sobre las visibles (no borradas y no ocultas; `UNDER_REVIEW` cuenta), nunca con sumas
 * incrementales, y **en la misma transacción** que el cambio que los afecta.
 *
 * Concurrencia: antes de agregar se bloquea la fila de la barbería y luego la del barbero (siempre
 * en ese orden). Con READ COMMITTED, la consulta agregada que sigue al bloqueo toma una instantánea
 * nueva y ve lo que confirmó la transacción que tenía el bloqueo: dos valoraciones simultáneas no
 * dejan un promedio que omita a una de ellas. El bloqueo es `FOR NO KEY UPDATE` (no `FOR UPDATE`):
 * la inserción de la valoración ya tomó `FOR KEY SHARE` por las claves foráneas, y `FOR UPDATE`
 * chocaría con ese bloqueo de la otra transacción (interbloqueo).
 */
@Injectable()
export class ReviewRatings {
  constructor(private readonly prisma: PrismaService) {}

  async recalculate(
    tx: Prisma.TransactionClient,
    barbershopId: string,
    barberId: string,
  ): Promise<void> {
    await this.recalculateBarbershop(tx, barbershopId);
    await this.recalculateBarber(tx, barberId);
  }

  async recalculateBarbershop(
    tx: Prisma.TransactionClient,
    barbershopId: string,
  ): Promise<RatingChange> {
    const [before] = await tx.$queryRaw<RatingRow[]>`
      SELECT rating_avg::text AS rating_avg, rating_count
        FROM barbershops WHERE id = ${barbershopId}::uuid FOR NO KEY UPDATE`;
    const [after] = await tx.$queryRaw<RatingRow[]>`
      UPDATE barbershops b
         SET rating_avg = s.avg, rating_count = s.cnt
        FROM (SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg, COUNT(*)::int AS cnt
                FROM reviews
               WHERE barbershop_id = ${barbershopId}::uuid
                 AND deleted_at IS NULL AND status <> 'HIDDEN') s
       WHERE b.id = ${barbershopId}::uuid
      RETURNING b.rating_avg::text AS rating_avg, b.rating_count`;
    return { before: toRating(before), after: toRating(after) };
  }

  async recalculateBarber(tx: Prisma.TransactionClient, barberId: string): Promise<RatingChange> {
    const [before] = await tx.$queryRaw<RatingRow[]>`
      SELECT rating_avg::text AS rating_avg, rating_count
        FROM barbers WHERE id = ${barberId}::uuid FOR NO KEY UPDATE`;
    const [after] = await tx.$queryRaw<RatingRow[]>`
      UPDATE barbers b
         SET rating_avg = s.avg, rating_count = s.cnt
        FROM (SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg, COUNT(*)::int AS cnt
                FROM reviews
               WHERE barber_id = ${barberId}::uuid
                 AND deleted_at IS NULL AND status <> 'HIDDEN') s
       WHERE b.id = ${barberId}::uuid
      RETURNING b.rating_avg::text AS rating_avg, b.rating_count`;
    return { before: toRating(before), after: toRating(after) };
  }
}

/**
 * Verificación nocturna: busca promedios que no coinciden con las valoraciones visibles, los
 * corrige con el mismo cálculo (y los mismos bloqueos) y deja cada corrección en `audit_log`. En
 * condiciones normales no encuentra nada; si encuentra algo, hay un error que investigar.
 */
@Injectable()
export class RatingsVerifier {
  private readonly logger = new Logger(RatingsVerifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ratings: ReviewRatings,
    private readonly audit: AuditService,
  ) {}

  async verifyAll(): Promise<{ barbershops: number; barbers: number }> {
    const shops = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT b.id::text AS id
        FROM barbershops b
        LEFT JOIN LATERAL (
          SELECT COALESCE(ROUND(AVG(r.rating)::numeric, 2), 0) AS avg, COUNT(*)::int AS cnt
            FROM reviews r
           WHERE r.barbershop_id = b.id AND r.deleted_at IS NULL AND r.status <> 'HIDDEN') s ON true
       WHERE b.rating_avg <> s.avg OR b.rating_count <> s.cnt
       ORDER BY b.id`;
    const barbers = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT b.id::text AS id
        FROM barbers b
        LEFT JOIN LATERAL (
          SELECT COALESCE(ROUND(AVG(r.rating)::numeric, 2), 0) AS avg, COUNT(*)::int AS cnt
            FROM reviews r
           WHERE r.barber_id = b.id AND r.deleted_at IS NULL AND r.status <> 'HIDDEN') s ON true
       WHERE b.rating_avg <> s.avg OR b.rating_count <> s.cnt
       ORDER BY b.id`;
    let fixedShops = 0;
    let fixedBarbers = 0;
    for (const { id } of shops) {
      if (await this.fix('barbershop', id, (tx) => this.ratings.recalculateBarbershop(tx, id))) {
        fixedShops++;
      }
    }
    for (const { id } of barbers) {
      if (await this.fix('barber', id, (tx) => this.ratings.recalculateBarber(tx, id))) {
        fixedBarbers++;
      }
    }
    if (fixedShops + fixedBarbers > 0) {
      this.logger.warn(
        { barbershops: fixedShops, barbers: fixedBarbers },
        'Promedios de valoraciones corregidos por la verificación nocturna',
      );
    }
    return { barbershops: fixedShops, barbers: fixedBarbers };
  }

  /** Corrige y audita en la misma transacción; si otra ya lo corrigió, no registra nada. */
  private fix(
    entityType: 'barbershop' | 'barber',
    id: string,
    recalculate: (tx: Prisma.TransactionClient) => Promise<RatingChange>,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const change = await recalculate(tx);
      const changed =
        change.before.average !== change.after.average ||
        change.before.count !== change.after.count;
      if (changed) {
        await this.audit.record(
          {
            action: 'rating.corrected',
            entityType,
            entityId: id,
            changes: { before: change.before, after: change.after },
          },
          tx,
        );
      }
      return changed;
    });
  }
}
