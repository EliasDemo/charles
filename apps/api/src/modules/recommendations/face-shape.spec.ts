import { classifyFaceShape, type FaceMeasurements, validMeasurements } from './face-shape';

/** Medidas a partir de las proporciones [largo, frente, mandíbula] con pómulos = 100. */
const face = (length: number, forehead: number, jaw: number): FaceMeasurements => ({
  faceLength: length,
  foreheadWidth: forehead,
  cheekboneWidth: 100,
  jawWidth: jaw,
});

describe('Clasificador de forma de cara', () => {
  it.each([
    ['OVAL', face(140, 92, 80)],
    ['ROUND', face(105, 92, 86)],
    ['SQUARE', face(112, 98, 97)],
    ['OBLONG', face(165, 95, 90)],
    ['HEART', face(132, 104, 68)],
    ['DIAMOND', face(135, 78, 72)],
  ])('reconoce una cara %s típica', (shape, m) => {
    const result = classifyFaceShape(m);
    expect(result.shape).toBe(shape);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('las proporciones importan, no la escala', () => {
    expect(classifyFaceShape(face(140, 92, 80))).toEqual(
      classifyFaceShape({ faceLength: 14, foreheadWidth: 9.2, cheekboneWidth: 10, jawWidth: 8 }),
    );
  });

  it('una cara mixta devuelve menos confianza y alternativas', () => {
    // Entre ovalada y redonda.
    const result = classifyFaceShape(face(124, 92, 83));
    expect(['OVAL', 'ROUND']).toContain(result.shape);
    expect(result.confidence).toBeLessThan(0.85);
    expect(result.alternatives.map((a) => a.shape)).toContain(
      result.shape === 'OVAL' ? 'ROUND' : 'OVAL',
    );
    const sum = result.confidence + result.alternatives.reduce((s, a) => s + a.probability, 0);
    expect(sum).toBeLessThanOrEqual(1.001);
  });

  it('rechaza medidas imposibles', () => {
    expect(validMeasurements(face(140, 92, 80))).toBe(true);
    expect(validMeasurements(face(0, 92, 80))).toBe(false);
    expect(validMeasurements(face(400, 92, 80))).toBe(false);
    expect(validMeasurements(face(140, 92, Number.NaN))).toBe(false);
    expect(validMeasurements({ ...face(140, 92, 80), cheekboneWidth: -1 })).toBe(false);
  });
});
