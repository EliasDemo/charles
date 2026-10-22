import { normalizeText, reachesReportThreshold, withinReviewWindow } from './review-policy';

describe('RF-VAL-002 reglas de valoraciones', () => {
  describe('texto plano', () => {
    it('recorta, colapsa espacios y conserva saltos simples', () => {
      expect(normalizeText('  Muy   bien \r\n\r\n\r\n  gracias  ')).toBe('Muy bien\n\ngracias');
    });
    it('vacío o solo espacios → null', () => {
      expect(normalizeText('   ')).toBeNull();
      expect(normalizeText(undefined)).toBeNull();
      expect(normalizeText(null)).toBeNull();
    });
    it('no interpreta HTML: lo deja como texto', () => {
      expect(normalizeText('<b>hola</b>')).toBe('<b>hola</b>');
    });
  });

  it('plazo inclusivo de N días desde ATTENDED', () => {
    const attended = new Date('2030-01-07T12:00:00Z');
    const day = 24 * 3600 * 1000;
    expect(withinReviewWindow(attended, attended.getTime() + 14 * day, 14)).toBe(true);
    expect(withinReviewWindow(attended, attended.getTime() + 14 * day + 1, 14)).toBe(false);
  });

  it('umbral de reportes', () => {
    expect(reachesReportThreshold(2, 3)).toBe(false);
    expect(reachesReportThreshold(3, 3)).toBe(true);
  });
});
