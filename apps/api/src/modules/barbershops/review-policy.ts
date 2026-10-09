import type { BarbershopStatus, OwnerDocumentType } from '../../generated/prisma/enums';

/**
 * Reglas puras del alta con revisión previa. Sin base ni reloj.
 *
 * DRAFT ──enviar──▶ PENDING_REVIEW ──aprobar──▶ OPEN
 *                     │ pedir cambios (motivo)
 *                     ▼
 *              CHANGES_REQUESTED ──reenviar──▶ PENDING_REVIEW
 */

/** Prefijos válidos del RUC peruano: 10 (persona natural), 15, 17 (otros), 20 (empresa). */
const RUC_PREFIXES = ['10', '15', '17', '20'];
const RUC_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** RUC: 11 dígitos, prefijo válido y dígito verificador (módulo 11 de SUNAT). */
export function isValidRuc(value: string): boolean {
  if (!/^\d{11}$/.test(value) || !RUC_PREFIXES.includes(value.slice(0, 2))) return false;
  const sum = RUC_WEIGHTS.reduce((acc, weight, i) => acc + weight * Number(value[i]), 0);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(value[10]);
}

export function isValidDni(value: string): boolean {
  return /^\d{8}$/.test(value);
}

export function isValidOwnerDocument(type: OwnerDocumentType, number: string): boolean {
  return type === 'RUC' ? isValidRuc(number) : isValidDni(number);
}

/** Solo los 3 últimos dígitos: `*****123`. */
export function maskDocument(number: string): string {
  return `${'*'.repeat(Math.max(number.length - 3, 0))}${number.slice(-3)}`;
}

export type ReviewRequirement = 'OWNER_DOCUMENT' | 'PHOTO';

/** Lo que falta para enviar a revisión. La foto solo si `barbershops.require_photo` (Fase 14). */
export function missingRequirements(input: {
  hasOwnerDocument: boolean;
  hasPhoto: boolean;
  requirePhoto: boolean;
}): ReviewRequirement[] {
  const missing: ReviewRequirement[] = [];
  if (!input.hasOwnerDocument) missing.push('OWNER_DOCUMENT');
  if (input.requirePhoto && !input.hasPhoto) missing.push('PHOTO');
  return missing;
}

/** Estados desde los que el dueño envía a revisión. */
export const SUBMITTABLE_STATUSES: readonly BarbershopStatus[] = ['DRAFT', 'CHANGES_REQUESTED'];

/** Ya aprobada alguna vez: un cambio de documento no la oculta, solo la marca para soporte. */
export function wasApproved(status: BarbershopStatus): boolean {
  return status === 'OPEN' || status === 'TEMPORARILY_CLOSED' || status === 'SUSPENDED';
}
