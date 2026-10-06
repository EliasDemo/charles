import { type Candidate, OrganicRankingStrategy, type SearchSort } from './ranking';

const candidate = (id: string): Candidate => ({
  id,
  name: id,
  type: 'BARBERSHOP',
  status: 'OPEN',
  address: 'x',
  latitude: -12,
  longitude: -77,
  timezone: 'America/Lima',
  ratingAverage: null,
  ratingCount: 0,
  distanceMeters: null,
  minPrice: null,
  serviceIds: [],
  sortValues: [id],
});

describe('OrganicRankingStrategy (RF-BUS-001, RF-BUS-002)', () => {
  const strategy = new OrganicRankingStrategy();

  it.each<[SearchSort, string[]]>([
    ['distance', ['distance:asc', 'id:asc']],
    ['rating', ['hasRating:desc', 'rating:desc', 'ratingCount:desc', 'id:asc']],
    ['price', ['minPrice:asc', 'id:asc']],
  ])('orden %s: claves en orden y desempate final por id', (sort, expected) => {
    expect(strategy.orderKeys(sort).map((k) => `${k.field}:${k.direction}`)).toEqual(expected);
  });

  it('valoración: las barberías sin valoraciones van al final (hasRating descendente primero)', () => {
    expect(strategy.orderKeys('rating')[0]).toEqual({ field: 'hasRating', direction: 'desc' });
  });

  it('el orden orgánico conserva la página y no marca destacados (Fase 13)', async () => {
    const page = [candidate('a'), candidate('b'), candidate('c')];
    const ranked = await strategy.arrange(page);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['a', 'b', 'c']);
    expect(ranked.every((r) => r.featured === false)).toBe(true);
  });
});
