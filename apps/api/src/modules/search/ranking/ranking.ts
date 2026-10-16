import type { BarbershopStatus, BarbershopType } from '../../../generated/prisma/enums';

/** Orden pedido por el cliente. */
export type SearchSort = 'distance' | 'rating' | 'price';

/** Barbería candidata tal como sale de la consulta (antes del ranking). */
export interface Candidate {
  id: string;
  name: string;
  type: BarbershopType;
  status: BarbershopStatus;
  address: string;
  latitude: number;
  longitude: number;
  timezone: string;
  /** null cuando no tiene valoraciones (rating_count = 0). */
  ratingAverage: number | null;
  ratingCount: number;
  /** Metros, redondeados; null si la búsqueda no tiene ubicación. */
  distanceMeters: number | null;
  /** Precio mínimo (céntimos) entre los servicios que cumplen los filtros; null si no hay. */
  minPrice: number | null;
  /** Servicios reservables que cumplen los filtros (para calcular disponibilidad). */
  serviceIds: string[];
  /** Valores de la clave de orden (para el cursor), en el orden de `OrderKey[]`. */
  sortValues: (number | string)[];
}

export interface Ranked<T extends Candidate = Candidate> {
  candidate: T;
  /** Resultado destacado (featured_listings, Fase 13). Siempre se marca como tal. */
  featured: boolean;
}

/** Una clave de orden, en términos que la consulta traduce a SQL (sin SQL aquí). */
export interface OrderKey {
  field: 'distance' | 'hasRating' | 'rating' | 'ratingCount' | 'minPrice' | 'id';
  direction: 'asc' | 'desc';
}

export interface RankingContext {
  sort: SearchSort;
  /** Primera página (sin cursor): donde una estrategia podría insertar destacados. */
  firstPage: boolean;
}

/**
 * Estrategia de ranking (CLAUDE.md §9). La búsqueda no conoce el orden: lo pide aquí.
 * - `orderKeys`: orden orgánico que la consulta aplica (con paginación por cursor).
 * - `arrange`: compone la página final (por ejemplo, destacados al inicio en la Fase 13).
 */
export interface RankingStrategy {
  orderKeys(sort: SearchSort): OrderKey[];
  arrange<T extends Candidate>(page: T[], context: RankingContext): Promise<Ranked<T>[]>;
}

export const RANKING_STRATEGY = Symbol('RANKING_STRATEGY');

/**
 * Orden orgánico (Fase 6), sin destacados:
 * - distance: más cerca primero.
 * - rating: con valoraciones primero (sin valoraciones al final), mayor promedio, más reseñas.
 * - price: menor "precio desde" primero (sin precio al final).
 * Siempre desempata por id para que el cursor sea estable.
 */
export class OrganicRankingStrategy implements RankingStrategy {
  orderKeys(sort: SearchSort): OrderKey[] {
    switch (sort) {
      case 'distance':
        return [
          { field: 'distance', direction: 'asc' },
          { field: 'id', direction: 'asc' },
        ];
      case 'rating':
        return [
          { field: 'hasRating', direction: 'desc' },
          { field: 'rating', direction: 'desc' },
          { field: 'ratingCount', direction: 'desc' },
          { field: 'id', direction: 'asc' },
        ];
      case 'price':
        return [
          { field: 'minPrice', direction: 'asc' },
          { field: 'id', direction: 'asc' },
        ];
    }
  }

  arrange<T extends Candidate>(page: T[]): Promise<Ranked<T>[]> {
    return Promise.resolve(page.map((candidate) => ({ candidate, featured: false })));
  }
}

/** Destacados por página (Fase 13). */
export const MAX_FEATURED_PER_PAGE = 3;

/**
 * Fase 13: orden orgánico más destacados. En la **primera página**, hasta `MAX_FEATURED_PER_PAGE`
 * barberías con un destacado vigente (de las que ya cumplen los filtros y están en la página) suben
 * al inicio, por prioridad, con `featured: true`. El resto conserva el orden orgánico. Como solo
 * reordena la página, un destacado nunca rompe los filtros ni se repite al paginar.
 */
export class FeaturedRankingStrategy implements RankingStrategy {
  private readonly organic = new OrganicRankingStrategy();

  constructor(private readonly activeFeatured: (ids: string[]) => Promise<string[]>) {}

  orderKeys(sort: SearchSort): OrderKey[] {
    return this.organic.orderKeys(sort);
  }

  async arrange<T extends Candidate>(page: T[], context: RankingContext): Promise<Ranked<T>[]> {
    if (!context.firstPage || page.length === 0) return this.organic.arrange(page);
    const featuredIds = (await this.activeFeatured(page.map((c) => c.id))).slice(
      0,
      MAX_FEATURED_PER_PAGE,
    );
    const byId = new Map(page.map((c) => [c.id, c]));
    const top = featuredIds.flatMap((id) => {
      const candidate = byId.get(id);
      return candidate ? [{ candidate, featured: true }] : [];
    });
    const chosen = new Set(featuredIds);
    const rest = page
      .filter((c) => !chosen.has(c.id))
      .map((candidate) => ({ candidate, featured: false }));
    return [...top, ...rest];
  }
}
