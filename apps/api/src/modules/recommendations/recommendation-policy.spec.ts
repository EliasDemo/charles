import {
  barberStyleScore,
  barberSummary,
  type BarberStyleStats,
  compatibility,
  DEFAULT_WEIGHTS,
} from './recommendation-policy';

const traits = {
  hairTypes: ['STRAIGHT', 'WAVY'] as const,
  vibe: 'MODERN' as const,
  maintenance: 'HIGH' as const,
};
const stats = (overrides: Partial<BarberStyleStats> = {}): BarberStyleStats => ({
  confirmedWorks: 10,
  sameShapeWorks: 5,
  ratingAverage: 4.8,
  ratingCount: 10,
  daysSinceLastWork: 10,
  distanceMeters: 1200,
  radiusMeters: 5000,
  ...overrides,
});

describe('Política de la recomendación por forma de cara', () => {
  it('compatibilidad: preferencias suman o restan; cabello incompatible descarta', () => {
    const t = { ...traits, hairTypes: [...traits.hairTypes] };
    expect(compatibility(80, t, {})).toBe(80);
    expect(compatibility(80, t, { vibe: 'MODERN' })).toBe(88);
    expect(compatibility(80, t, { vibe: 'CLASSIC' })).toBe(72);
    // Quiere poco mantenimiento y el corte es de mucho: −24.
    expect(compatibility(80, t, { maintenance: 'LOW' })).toBe(56);
    expect(compatibility(80, t, { maintenance: 'HIGH' })).toBe(85);
    expect(compatibility(80, t, { hairType: 'COILY' })).toBeNull();
    expect(compatibility(98, t, { vibe: 'MODERN', maintenance: 'HIGH' })).toBe(100);
    // Sin datos del corte, las preferencias no cambian nada.
    expect(
      compatibility(
        70,
        { hairTypes: [], vibe: null, maintenance: null },
        { hairType: 'COILY', vibe: 'CLASSIC' },
      ),
    ).toBe(70);
  });

  it('ranking: más trabajos en la misma forma, mejores estrellas y más cerca suben', () => {
    const base = barberStyleScore(stats(), DEFAULT_WEIGHTS);
    expect(barberStyleScore(stats({ sameShapeWorks: 15 }), DEFAULT_WEIGHTS)).toBeGreaterThan(base);
    expect(
      barberStyleScore(stats({ ratingAverage: 3, ratingCount: 20 }), DEFAULT_WEIGHTS),
    ).toBeLessThan(base);
    expect(barberStyleScore(stats({ distanceMeters: 4900 }), DEFAULT_WEIGHTS)).toBeLessThan(base);
    expect(barberStyleScore(stats({ daysSinceLastWork: 720 }), DEFAULT_WEIGHTS)).toBeLessThan(base);
    expect(base).toBeGreaterThan(0);
    expect(base).toBeLessThanOrEqual(1);
  });

  it('ranking: sin valoraciones queda neutro; pesos en cero dan 0', () => {
    const none = barberStyleScore(
      stats({ ratingAverage: null, ratingCount: 0, daysSinceLastWork: null }),
      DEFAULT_WEIGHTS,
    );
    expect(none).toBeGreaterThan(0);
    expect(
      barberStyleScore(stats(), { works: 0, sameShape: 0, rating: 0, recency: 0, distance: 0 }),
    ).toBe(0);
    // Solo la distancia cuenta.
    expect(
      barberStyleScore(stats({ distanceMeters: 0 }), {
        works: 0,
        sameShape: 0,
        rating: 0,
        recency: 0,
        distance: 10,
      }),
    ).toBe(1);
  });

  it('resumen legible para el cliente', () => {
    expect(barberSummary(stats({ sameShapeWorks: 23, ratingAverage: 4.9 }), 'OVAL')).toBe(
      '23 trabajos de este corte en caras ovaladas · 4,9 ★ · a 1,2 km',
    );
    expect(
      barberSummary(
        stats({ sameShapeWorks: 0, confirmedWorks: 1, ratingCount: 0, distanceMeters: 340 }),
        'ROUND',
      ),
    ).toBe('1 trabajo de este corte · a 340 m');
  });
});
