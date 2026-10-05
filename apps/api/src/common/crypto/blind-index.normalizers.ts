import { BlindIndexKind } from './encryption-contexts';

/**
 * Normalización previa al índice ciego: dos formas de escribir el mismo dato
 * deben producir el mismo hash. Cambiar una normalización invalida los hashes existentes.
 */
export const BLIND_INDEX_NORMALIZERS: Record<BlindIndexKind, (value: string) => string> = {
  [BlindIndexKind.EMAIL]: (value) => value.normalize('NFC').trim().toLowerCase(),
  // Solo dígitos y un "+" inicial: "+51 987-654-321" → "+51987654321".
  [BlindIndexKind.PHONE]: (value) => {
    const trimmed = value.normalize('NFC').trim();
    const digits = trimmed.replace(/\D/g, '');
    return trimmed.startsWith('+') ? `+${digits}` : digits;
  },
  // Mayúsculas, sin espacios, guiones ni puntos: "ab-123 45" → "AB12345".
  [BlindIndexKind.DOCUMENT]: (value) =>
    value
      .normalize('NFC')
      .trim()
      .toUpperCase()
      .replace(/[\s.-]/g, ''),
};
