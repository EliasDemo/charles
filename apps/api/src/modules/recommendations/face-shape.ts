/**
 * Clasificador de forma de cara (Etapa 1). Pura: sin base de datos ni IA externa.
 *
 * Recibe cuatro medidas de la cara, en cualquier unidad (se usan sus proporciones), que la app
 * calcula **en el teléfono** a partir de los puntos del detector de rostro:
 * - `faceLength`: de la línea del cabello (o el centro de la frente) al mentón;
 * - `foreheadWidth`: ancho de la frente;
 * - `cheekboneWidth`: ancho entre pómulos (la parte más ancha de la cara media);
 * - `jawWidth`: ancho de la mandíbula a la altura de sus ángulos.
 *
 * Método: compara tres proporciones (largo/pómulos, frente/pómulos, mandíbula/pómulos) con un
 * prototipo de cada forma y convierte la distancia en una probabilidad. Es una aproximación: muchas
 * caras son mixtas, por eso devuelve la confianza y las alternativas, y la app lo presenta como
 * recomendación, no como verdad.
 */

export const FACE_SHAPES = ['OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND'] as const;
export type FaceShape = (typeof FACE_SHAPES)[number];

export interface FaceMeasurements {
  faceLength: number;
  foreheadWidth: number;
  cheekboneWidth: number;
  jawWidth: number;
}

export interface FaceShapeResult {
  shape: FaceShape;
  /** Probabilidad de la forma elegida (0 a 1). */
  confidence: number;
  /** Otras formas con probabilidad ≥ ALTERNATIVE_MIN, de mayor a menor. */
  alternatives: { shape: FaceShape; probability: number }[];
}

/** Prototipos: [largo/pómulos, frente/pómulos, mandíbula/pómulos]. */
const PROTOTYPES: Record<FaceShape, [number, number, number]> = {
  OVAL: [1.4, 0.92, 0.8],
  ROUND: [1.08, 0.92, 0.86],
  SQUARE: [1.12, 0.97, 0.96],
  OBLONG: [1.62, 0.95, 0.9],
  HEART: [1.32, 1.02, 0.7],
  DIAMOND: [1.35, 0.8, 0.74],
};
/** Peso de cada proporción (el largo distingue más; frente y mandíbula, igual). */
const WEIGHTS: [number, number, number] = [1, 1.6, 1.6];
/** Qué tan "suave" es la asignación: más alto, más repartida la probabilidad. */
const SPREAD = 0.012;
export const ALTERNATIVE_MIN = 0.15;

/** Medidas imposibles (no positivas o proporciones fuera de toda cara humana). */
export function validMeasurements(m: FaceMeasurements): boolean {
  const values = [m.faceLength, m.foreheadWidth, m.cheekboneWidth, m.jawWidth];
  if (!values.every((v) => Number.isFinite(v) && v > 0)) return false;
  const ratios = proportions(m);
  return (
    ratios[0] > 0.7 &&
    ratios[0] < 2.3 &&
    ratios[1] > 0.5 &&
    ratios[1] < 1.5 &&
    ratios[2] > 0.4 &&
    ratios[2] < 1.4
  );
}

export function classifyFaceShape(m: FaceMeasurements): FaceShapeResult {
  const ratios = proportions(m);
  const weights = FACE_SHAPES.map((shape) => {
    const p = PROTOTYPES[shape];
    const d2 =
      WEIGHTS[0] * (ratios[0] - p[0]) ** 2 +
      WEIGHTS[1] * (ratios[1] - p[1]) ** 2 +
      WEIGHTS[2] * (ratios[2] - p[2]) ** 2;
    return { shape, weight: Math.exp(-d2 / SPREAD) };
  });
  const total = weights.reduce((sum, w) => sum + w.weight, 0) || 1;
  const ranked = weights
    .map((w) => ({ shape: w.shape, probability: round(w.weight / total) }))
    .sort((a, b) => b.probability - a.probability);
  const [best, ...rest] = ranked;
  return {
    shape: best!.shape,
    confidence: best!.probability,
    alternatives: rest.filter((r) => r.probability >= ALTERNATIVE_MIN),
  };
}

/** [largo/pómulos, frente/pómulos, mandíbula/pómulos]: lo que se guarda para buscar caras parecidas. */
export function faceProportions(m: FaceMeasurements): [number, number, number] {
  return proportions(m);
}

function proportions(m: FaceMeasurements): [number, number, number] {
  return [
    m.faceLength / m.cheekboneWidth,
    m.foreheadWidth / m.cheekboneWidth,
    m.jawWidth / m.cheekboneWidth,
  ];
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
