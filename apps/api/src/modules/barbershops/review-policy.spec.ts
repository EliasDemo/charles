import {
  isValidDni,
  isValidOwnerDocument,
  isValidRuc,
  maskDocument,
  missingRequirements,
  wasApproved,
} from './review-policy';

describe('Alta con revisión: reglas puras', () => {
  describe('RUC (módulo 11 y prefijos)', () => {
    it.each([
      ['20100047218', true], // RUC real de empresa (prefijo 20)
      ['20131312955', true],
      ['10467793549', true], // persona natural (prefijo 10)
      ['20100047219', false], // dígito verificador incorrecto
      ['30100047218', false], // prefijo inválido
      ['2010004721', false], // 10 dígitos
      ['2010004721A', false],
      ['', false],
    ])('%s → %s', (ruc, valid) => {
      expect(isValidRuc(ruc)).toBe(valid);
    });
  });

  it('DNI: exactamente 8 dígitos', () => {
    expect(isValidDni('12345678')).toBe(true);
    expect(isValidDni('1234567')).toBe(false);
    expect(isValidDni('123456789')).toBe(false);
    expect(isValidDni('1234567a')).toBe(false);
    expect(isValidOwnerDocument('DNI', '12345678')).toBe(true);
    expect(isValidOwnerDocument('RUC', '12345678')).toBe(false);
  });

  it('enmascarado: solo los 3 últimos dígitos', () => {
    expect(maskDocument('20100047218')).toBe('********218');
    expect(maskDocument('12345678')).toBe('*****678');
  });

  it('requisitos: documento siempre; foto solo si el ajuste la exige', () => {
    expect(
      missingRequirements({ hasOwnerDocument: false, hasPhoto: false, requirePhoto: false }),
    ).toEqual(['OWNER_DOCUMENT']);
    expect(
      missingRequirements({ hasOwnerDocument: true, hasPhoto: false, requirePhoto: true }),
    ).toEqual(['PHOTO']);
    expect(
      missingRequirements({ hasOwnerDocument: true, hasPhoto: true, requirePhoto: true }),
    ).toEqual([]);
  });

  it('aprobada alguna vez', () => {
    expect(wasApproved('OPEN')).toBe(true);
    expect(wasApproved('SUSPENDED')).toBe(true);
    expect(wasApproved('DRAFT')).toBe(false);
    expect(wasApproved('PENDING_REVIEW')).toBe(false);
    expect(wasApproved('CHANGES_REQUESTED')).toBe(false);
  });
});
