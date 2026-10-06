import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { BarbershopStatus, BarbershopType } from '../../generated/prisma/enums';
import type { Candidate, OrderKey } from './ranking/ranking';

/** Filtros que la base resuelve (los de disponibilidad se evalúan después, por lotes). */
export interface CandidateFilters {
  /** Punto de búsqueda: solo vive en esta consulta (nunca se guarda ni se registra). */
  origin?: { lat: number; lng: number; radiusMeters: number };
  /** Texto ya recortado (2–80): coincide con el nombre de la barbería o de sus servicios. */
  text?: string;
  categoryKey?: string;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  type?: BarbershopType;
  excludeBarbershopId?: string;
}

interface Row {
  id: string;
  name: string;
  type: BarbershopType;
  status: BarbershopStatus;
  address: string;
  latitude: number;
  longitude: number;
  timezone: string;
  rating_avg: number;
  rating_count: number;
  has_rating: number;
  rating_x100: number;
  distance_m: number | null;
  min_price: number | null;
  price_key: number;
  service_ids: string[] | null;
}

/** Columna de la subconsulta `c` por clave de orden (lista cerrada: nunca entrada externa). */
const COLUMN: Record<
  OrderKey['field'],
  { sql: string; cast: string; read: (r: Row) => number | string }
> = {
  distance: { sql: 'c.distance_m', cast: 'int', read: (r) => r.distance_m ?? 0 },
  hasRating: { sql: 'c.has_rating', cast: 'int', read: (r) => r.has_rating },
  rating: { sql: 'c.rating_x100', cast: 'int', read: (r) => r.rating_x100 },
  ratingCount: { sql: 'c.rating_count', cast: 'int', read: (r) => r.rating_count },
  minPrice: { sql: 'c.price_key', cast: 'int', read: (r) => r.price_key },
  id: { sql: 'c.id', cast: 'uuid', read: (r) => r.id },
};

/** Escapa los comodines de LIKE: el texto del cliente se busca literal. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Consulta de candidatos con PostGIS (`ST_DWithin` sobre `location`, índice GiST). Siempre
 * parametrizada: los valores del cliente viajan como parámetros; solo los nombres de columna del
 * orden (lista cerrada) se insertan como SQL.
 */
@Injectable()
export class SearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async candidates(
    filters: CandidateFilters,
    order: OrderKey[],
    after: (number | string)[] | null,
    take: number,
  ): Promise<Candidate[]> {
    const point = filters.origin
      ? Prisma.sql`ST_SetSRID(ST_MakePoint(${filters.origin.lng}::float8, ${filters.origin.lat}::float8), 4326)::geography`
      : null;
    const distance = point
      ? Prisma.sql`ROUND(ST_Distance(b.location, ${point}))::int`
      : Prisma.sql`NULL::int`;

    const serviceConditions: Prisma.Sql[] = [];
    if (filters.categoryKey) serviceConditions.push(Prisma.sql`sc.key = ${filters.categoryKey}`);
    if (filters.minPrice !== undefined)
      serviceConditions.push(Prisma.sql`sv.price_amount >= ${filters.minPrice}::int`);
    if (filters.maxPrice !== undefined)
      serviceConditions.push(Prisma.sql`sv.price_amount <= ${filters.maxPrice}::int`);
    const serviceFilter = serviceConditions.length
      ? Prisma.sql`AND ${Prisma.join(serviceConditions, ' AND ')}`
      : Prisma.empty;

    const where: Prisma.Sql[] = [
      Prisma.sql`b.deleted_at IS NULL`,
      Prisma.sql`b.status IN ('OPEN', 'TEMPORARILY_CLOSED')`,
    ];
    if (point && filters.origin)
      where.push(
        Prisma.sql`ST_DWithin(b.location, ${point}, ${filters.origin.radiusMeters}::float8)`,
      );
    if (filters.type) where.push(Prisma.sql`b.type = ${filters.type}::"BarbershopType"`);
    if (filters.minRating !== undefined)
      where.push(Prisma.sql`b.rating_count > 0 AND b.rating_avg >= ${filters.minRating}::numeric`);
    if (serviceConditions.length) where.push(Prisma.sql`s.min_price IS NOT NULL`);
    if (filters.excludeBarbershopId)
      where.push(Prisma.sql`b.id <> ${filters.excludeBarbershopId}::uuid`);
    if (filters.text) {
      const pattern = likePattern(filters.text);
      where.push(Prisma.sql`(
        charles_normalize(b.name) LIKE charles_normalize(${pattern}) ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM services sq
          WHERE sq.barbershop_id = b.id AND sq.deleted_at IS NULL AND sq.is_available
            AND charles_normalize(sq.name) LIKE charles_normalize(${pattern}) ESCAPE '\\'
        )
      )`);
    }

    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT * FROM (
        SELECT b.id AS id, b.name, b.type::text AS type, b.status::text AS status, b.address,
               b.latitude, b.longitude, b.timezone,
               b.rating_avg::float8 AS rating_avg, b.rating_count,
               CASE WHEN b.rating_count > 0 THEN 1 ELSE 0 END AS has_rating,
               ROUND(b.rating_avg * 100)::int AS rating_x100,
               ${distance} AS distance_m,
               s.min_price, COALESCE(s.min_price, 2147483647) AS price_key, s.service_ids
        FROM barbershops b
        LEFT JOIN LATERAL (
          SELECT MIN(sv.price_amount)::int AS min_price,
                 array_agg(sv.id::text ORDER BY sv.price_amount, sv.id) AS service_ids
          FROM services sv
          JOIN service_categories sc ON sc.id = sv.category_id
          WHERE sv.barbershop_id = b.id AND sv.deleted_at IS NULL AND sv.is_available
            ${serviceFilter}
        ) s ON true
        WHERE ${Prisma.join(where, ' AND ')}
      ) c
      ${after ? Prisma.sql`WHERE ${keyset(order, after)}` : Prisma.empty}
      ORDER BY ${Prisma.raw(order.map((k) => `${COLUMN[k.field].sql} ${k.direction.toUpperCase()}`).join(', '))}
      LIMIT ${take}::int`;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      status: r.status,
      address: r.address,
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: r.timezone,
      ratingAverage: r.rating_count > 0 ? r.rating_avg : null,
      ratingCount: r.rating_count,
      distanceMeters: r.distance_m,
      minPrice: r.min_price,
      serviceIds: r.service_ids ?? [],
      sortValues: order.map((k) => COLUMN[k.field].read(r)),
    }));
  }
}

/**
 * Condición "después de" para paginación por cursor con varias claves y direcciones:
 * (k1 > v1) OR (k1 = v1 AND k2 > v2) OR … (con < para las claves descendentes).
 */
function keyset(order: OrderKey[], values: (number | string)[]): Prisma.Sql {
  const value = (i: number): Prisma.Sql =>
    Prisma.sql`${values[i]}::${Prisma.raw(COLUMN[order[i]!.field].cast)}`;
  const column = (i: number): Prisma.Sql => Prisma.raw(COLUMN[order[i]!.field].sql);
  const branches = order.map((key, i) => {
    const equal = order.slice(0, i).map((_k, j) => Prisma.sql`${column(j)} = ${value(j)}`);
    const op = Prisma.raw(key.direction === 'asc' ? '>' : '<');
    return Prisma.sql`(${Prisma.join([...equal, Prisma.sql`${column(i)} ${op} ${value(i)}`], ' AND ')})`;
  });
  return Prisma.sql`(${Prisma.join(branches, ' OR ')})`;
}
