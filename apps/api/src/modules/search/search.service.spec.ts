import { AppException } from '../../common/errors/app.exception';
import type { AvailabilityRequest } from '../availability/availability.service';
import type { Slot } from '../availability/engine/compute-slots';
import type { SearchQueryDto } from './dto/search.dto';
import {
  type Candidate,
  type OrderKey,
  OrganicRankingStrategy,
  type Ranked,
  type RankingContext,
  type RankingStrategy,
  type SearchSort,
} from './ranking/ranking';
import type { SearchCursor } from './search-cursor';
import type { CandidateFilters, SearchRepository } from './search.repository';
import { SearchService } from './search.service';

/** Candidatas ya ordenadas; el "cursor" es la posición. */
function candidates(n: number): Candidate[] {
  return Array.from({ length: n }, (_v, i) => ({
    id: `shop-${i}`,
    name: `Shop ${i}`,
    type: 'BARBERSHOP' as const,
    status: 'OPEN' as const,
    address: 'x',
    latitude: -12,
    longitude: -77,
    timezone: 'America/Lima',
    ratingAverage: null,
    ratingCount: 0,
    distanceMeters: i * 100,
    minPrice: 2500,
    serviceIds: [`svc-${i}`],
    sortValues: [i],
  }));
}

class FakeRepository {
  calls: { take: number; after: (number | string)[] | null }[] = [];
  lastFilters: CandidateFilters | undefined;

  constructor(private readonly rows: Candidate[]) {}

  candidates(
    filters: CandidateFilters,
    _order: OrderKey[],
    after: (number | string)[] | null,
    take: number,
  ): Promise<Candidate[]> {
    this.calls.push({ take, after });
    this.lastFilters = filters;
    const start = after ? Number(after[0]) + 1 : 0;
    return Promise.resolve(this.rows.slice(start, start + take));
  }
}

const slot: Slot = { start: 1, end: 2, barberIds: ['b'] };

function build(options: {
  rows: Candidate[];
  available?: Set<string>;
  open?: Set<string>;
  ranking?: RankingStrategy;
  settings?: Record<string, number>;
}) {
  const repository = new FakeRepository(options.rows);
  const toSlots = (requests: AvailabilityRequest[]) =>
    new Map(
      requests.map((r) => [
        `${r.barbershopId}|${r.serviceId}|*`,
        options.available?.has(r.barbershopId) ? slot : null,
      ]),
    );
  const availability = {
    availableNowBatch: jest.fn((requests: AvailabilityRequest[]) =>
      Promise.resolve(toSlots(requests)),
    ),
    availableOnDateBatch: jest.fn((requests: AvailabilityRequest[]) =>
      Promise.resolve(toSlots(requests)),
    ),
    openNowBatch: jest.fn((ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, options.open?.has(id) ?? false]))),
    ),
    todayIn: () => '2030-01-07',
  };
  const settings = {
    positiveInt: (key: string, fallback: number) =>
      Promise.resolve(options.settings?.[key] ?? fallback),
  };
  const services = {
    findActiveCategoryId: (key: string) => Promise.resolve(key === 'haircut' ? 'id' : null),
  };
  const cursor = {
    encode: (_sort: SearchSort, values: (number | string)[]) => JSON.stringify(values),
    decode: (value: string) => JSON.parse(value) as (number | string)[],
  };
  const service = new SearchService(
    repository as unknown as SearchRepository,
    availability as never,
    {} as never,
    services as never,
    settings as never,
    cursor as unknown as SearchCursor,
    options.ranking ?? new OrganicRankingStrategy(),
    { favoriteIds: () => Promise.resolve(new Set<string>()) } as never,
    {
      image: { findMany: () => Promise.resolve([]) },
      serviceStyle: {
        findFirst: ({ where }: { where: { key: string } }) =>
          Promise.resolve(where.key === 'fade_low' ? { id: 'style' } : null),
      },
    } as never,
    { publicUrl: (key: string) => `/media/${key}` } as never,
  );
  return { service, repository, availability };
}

const run = (s: SearchService, query: Partial<SearchQueryDto>) => s.search(query);

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return { code: error.code, details: error.details };
    throw error;
  }
  return undefined;
};

describe('SearchService', () => {
  describe('ranking intercambiable (preparado para destacados, Fase 13)', () => {
    /** Estrategia de ejemplo: pone primero, marcada como destacada, una barbería concreta. */
    class FeaturedFirst implements RankingStrategy {
      contexts: RankingContext[] = [];
      orderKeys(sort: SearchSort): OrderKey[] {
        return new OrganicRankingStrategy().orderKeys(sort);
      }
      arrange<T extends Candidate>(page: T[], context: RankingContext): Promise<Ranked<T>[]> {
        this.contexts.push(context);
        const featured = page.filter((c) => c.id === 'shop-2');
        const rest = page.filter((c) => c.id !== 'shop-2');
        return Promise.resolve([
          ...featured.map((candidate) => ({ candidate, featured: true })),
          ...rest.map((candidate) => ({ candidate, featured: false })),
        ]);
      }
    }

    it('la búsqueda respeta el orden y la marca de destacado que decide la estrategia', async () => {
      const ranking = new FeaturedFirst();
      const { service } = build({ rows: candidates(4), ranking });
      const page = await run(service, { lat: -12, lng: -77 });
      expect(page.items.map((i) => [i.id, i.featured])).toEqual([
        ['shop-2', true],
        ['shop-0', false],
        ['shop-1', false],
        ['shop-3', false],
      ]);
      expect(ranking.contexts).toEqual([{ sort: 'distance', firstPage: true }]);
    });

    it('con cursor la estrategia sabe que no es la primera página', async () => {
      const ranking = new FeaturedFirst();
      const { service } = build({ rows: candidates(4), ranking });
      await run(service, { cursor: JSON.stringify([0]) });
      expect(ranking.contexts).toEqual([{ sort: 'rating', firstPage: false }]);
    });
  });

  describe('paginación sin filtros de disponibilidad', () => {
    it('pide un elemento de más para saber si hay página siguiente', async () => {
      const { service, repository } = build({ rows: candidates(5) });
      const first = await run(service, { limit: 2 });
      expect(repository.calls).toEqual([{ take: 3, after: null }]);
      expect(first.items.map((i) => i.id)).toEqual(['shop-0', 'shop-1']);
      expect(first.nextCursor).toBe(JSON.stringify([1]));
      const last = await run(service, { limit: 2, cursor: JSON.stringify([3]) });
      expect(last.items.map((i) => i.id)).toEqual(['shop-4']);
      expect(last.nextCursor).toBeNull();
      expect(last.evaluationLimitReached).toBe(false);
    });

    it('el radio se recorta al máximo y el tamaño de página al tope configurados', async () => {
      const { service, repository } = build({
        rows: candidates(10),
        settings: { 'search.max_radius_km': 25, 'search.max_page_size': 3 },
      });
      const page = await run(service, { lat: -12, lng: -77, radiusKm: 400, limit: 50 });
      expect(repository.lastFilters?.origin?.radiusMeters).toBe(25_000);
      expect(page.items).toHaveLength(3);
    });

    it('radio por defecto: 5 km', async () => {
      const { service, repository } = build({ rows: candidates(1) });
      await run(service, { lat: -12, lng: -77 });
      expect(repository.lastFilters?.origin?.radiusMeters).toBe(5_000);
    });
  });

  describe('filtros de disponibilidad: recorrido por tandas con tope de candidatos', () => {
    it('evalúa por lotes hasta llenar la página', async () => {
      const { service, availability } = build({
        rows: candidates(100),
        available: new Set(['shop-3', 'shop-40', 'shop-41', 'shop-90']),
      });
      const page = await run(service, { availableNow: true, limit: 2 });
      expect(page.items.map((i) => i.id)).toEqual(['shop-3', 'shop-40']);
      expect(page.items.every((i) => i.availableNow)).toBe(true);
      expect(page.nextCursor).toBe(JSON.stringify([40]));
      expect(page.evaluationLimitReached).toBe(false);
      // Dos tandas de 25: nunca una consulta por barbería.
      expect(availability.availableNowBatch).toHaveBeenCalledTimes(2);
    });

    it('al llegar al tope devuelve lo encontrado, con el cursor del último evaluado', async () => {
      const { service } = build({
        rows: candidates(100),
        available: new Set(['shop-3', 'shop-45']),
        settings: { 'search.max_candidates': 30 },
      });
      const page = await run(service, { availableNow: true, limit: 5 });
      expect(page.items.map((i) => i.id)).toEqual(['shop-3']);
      expect(page.evaluationLimitReached).toBe(true);
      expect(page.nextCursor).toBe(JSON.stringify([29]));
      const next = await run(service, { availableNow: true, limit: 5, cursor: page.nextCursor! });
      expect(next.items.map((i) => i.id)).toEqual(['shop-45']);
    });

    it('sin más candidatas termina sin cursor', async () => {
      const { service } = build({ rows: candidates(3), open: new Set(['shop-1']) });
      const page = await run(service, { openNow: true });
      expect(page.items.map((i) => [i.id, i.isOpenNow])).toEqual([['shop-1', true]]);
      expect(page.nextCursor).toBeNull();
      expect(page.evaluationLimitReached).toBe(false);
    });

    it('una barbería sin servicios reservables nunca está disponible', async () => {
      const rows = candidates(2).map((c) => ({ ...c, serviceIds: [] }));
      const { service } = build({ rows, available: new Set(['shop-0', 'shop-1']) });
      expect((await run(service, { date: '2030-01-07' })).items).toEqual([]);
    });
  });

  describe('validación entre parámetros', () => {
    it.each<[string, Partial<SearchQueryDto>, string, string]>([
      ['lat sin lng', { lat: -12 }, 'lng', 'locationPair'],
      ['lng sin lat', { lng: -77 }, 'lat', 'locationPair'],
      ['radio sin ubicación', { radiusKm: 2 }, 'radiusKm', 'requiresLocation'],
      ['distancia sin ubicación', { sort: 'distance' }, 'sort', 'requiresLocation'],
      [
        'precio mínimo mayor que el máximo',
        { minPrice: 5, maxPrice: 1 },
        'maxPrice',
        'gteMinPrice',
      ],
      ['fecha inexistente', { date: '2030-02-30' }, 'date', 'isDate'],
      ['categoría inexistente', { category: 'nope' }, 'category', 'activeCategory'],
    ])('%s', async (_case, query, field, constraint) => {
      const { service } = build({ rows: [] });
      expect(await errorOf(run(service, query))).toEqual({
        code: 'VALIDATION_ERROR',
        details: [{ field, constraints: [constraint] }],
      });
    });
  });
});
