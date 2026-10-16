/**
 * Puntajes de la recomendación por forma de cara (Etapa 1). Puros: se prueban aislados.
 */

export type HairType = 'STRAIGHT' | 'WAVY' | 'CURLY' | 'COILY';
export type Vibe = 'CLASSIC' | 'MODERN';
export type Maintenance = 'LOW' | 'MEDIUM' | 'HIGH';

export interface StylePreferences {
  hairType?: HairType;
  vibe?: Vibe;
  maintenance?: Maintenance;
}

export interface StyleTraits {
  hairTypes: HairType[];
  vibe: Vibe | null;
  maintenance: Maintenance | null;
}

const MAINTENANCE_LEVEL: Record<Maintenance, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Compatibilidad final de un corte (0–100): parte del puntaje de la regla forma ↔ corte y la ajusta
 * con las preferencias. Un tipo de cabello con el que el corte no funciona lo descarta (`null`).
 */
export function compatibility(
  ruleScore: number,
  traits: StyleTraits,
  prefs: StylePreferences,
): number | null {
  if (prefs.hairType && traits.hairTypes.length > 0 && !traits.hairTypes.includes(prefs.hairType)) {
    return null;
  }
  let score = ruleScore;
  if (prefs.vibe && traits.vibe) score += prefs.vibe === traits.vibe ? 8 : -8;
  if (prefs.maintenance && traits.maintenance) {
    // Cada nivel de más (más trabajo del que quiere) resta; de menos, no.
    const extra = MAINTENANCE_LEVEL[traits.maintenance] - MAINTENANCE_LEVEL[prefs.maintenance];
    score += extra > 0 ? -12 * extra : extra === 0 ? 5 : 0;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export interface RankingWeights {
  works: number;
  sameShape: number;
  rating: number;
  recency: number;
  distance: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  works: 30,
  sameShape: 25,
  rating: 25,
  recency: 10,
  distance: 10,
};

export interface BarberStyleStats {
  /** Trabajos confirmados de ese corte (en toda su carrera). */
  confirmedWorks: number;
  /** De ellos, en caras de la misma forma que la del cliente. */
  sameShapeWorks: number;
  /** Estrellas en reservas de ese corte (visibles). */
  ratingAverage: number | null;
  ratingCount: number;
  /** Días desde su trabajo confirmado más reciente de ese corte (null si no tiene). */
  daysSinceLastWork: number | null;
  distanceMeters: number;
  radiusMeters: number;
}

/** Con cuántos trabajos un factor llega a su máximo (crece rápido al inicio y luego se aplana). */
const WORKS_SATURATION = 30;
const SAME_SHAPE_SATURATION = 15;
/** Promedio bayesiano de las estrellas: media 4 con peso 3 (pocas valoraciones no deciden). */
const RATING_PRIOR = { mean: 4, weight: 3 };
/** En cuántos días un trabajo pierde la mitad de su peso por antigüedad. */
const RECENCY_HALF_LIFE_DAYS = 180;

/** Puntaje (0–1) de un barbero en un corte, con los pesos configurables de ADMIN. */
export function barberStyleScore(stats: BarberStyleStats, weights: RankingWeights): number {
  const saturate = (n: number, max: number) => Math.min(1, Math.log1p(n) / Math.log1p(max));
  const rating =
    stats.ratingCount > 0 && stats.ratingAverage !== null
      ? (RATING_PRIOR.mean * RATING_PRIOR.weight + stats.ratingAverage * stats.ratingCount) /
        (RATING_PRIOR.weight + stats.ratingCount) /
        5
      : RATING_PRIOR.mean / 5 / 2; // sin valoraciones en ese corte: neutro bajo
  const recency =
    stats.daysSinceLastWork === null
      ? 0
      : 0.5 ** (stats.daysSinceLastWork / RECENCY_HALF_LIFE_DAYS);
  const distance =
    stats.radiusMeters > 0 ? 1 - Math.min(1, stats.distanceMeters / stats.radiusMeters) : 0;
  const parts: [number, number][] = [
    [weights.works, saturate(stats.confirmedWorks, WORKS_SATURATION)],
    [weights.sameShape, saturate(stats.sameShapeWorks, SAME_SHAPE_SATURATION)],
    [weights.rating, rating],
    [weights.recency, recency],
    [weights.distance, distance],
  ];
  const total = parts.reduce((s, [w]) => s + w, 0);
  if (total === 0) return 0;
  return Math.round((parts.reduce((s, [w, v]) => s + w * v, 0) / total) * 1000) / 1000;
}

const SHAPE_LABEL: Record<string, string> = {
  OVAL: 'ovaladas',
  ROUND: 'redondas',
  SQUARE: 'cuadradas',
  OBLONG: 'alargadas',
  HEART: 'de corazón',
  DIAMOND: 'de diamante',
};

/** Resumen para el cliente: "23 trabajos de este corte en caras ovaladas · 4,9 ★ · a 1,2 km". */
export function barberSummary(stats: BarberStyleStats, faceShape: string): string {
  const parts: string[] = [];
  if (stats.sameShapeWorks > 0) {
    parts.push(
      `${stats.sameShapeWorks} ${stats.sameShapeWorks === 1 ? 'trabajo' : 'trabajos'} de este corte en caras ${SHAPE_LABEL[faceShape] ?? ''}`.trim(),
    );
  } else if (stats.confirmedWorks > 0) {
    parts.push(
      `${stats.confirmedWorks} ${stats.confirmedWorks === 1 ? 'trabajo' : 'trabajos'} de este corte`,
    );
  }
  if (stats.ratingCount > 0 && stats.ratingAverage !== null) {
    parts.push(`${stats.ratingAverage.toFixed(1).replace('.', ',')} ★`);
  }
  parts.push(
    stats.distanceMeters < 1000
      ? `a ${Math.round(stats.distanceMeters / 10) * 10} m`
      : `a ${(stats.distanceMeters / 1000).toFixed(1).replace('.', ',')} km`,
  );
  return parts.join(' · ');
}
