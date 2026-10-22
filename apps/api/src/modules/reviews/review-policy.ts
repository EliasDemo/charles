/**
 * Reglas puras de valoraciones (Fase 11, RF-VAL-001…003). Sin base ni reloj: se prueban aisladas.
 */

export const REVIEW_DEFAULTS = {
  windowDays: 14,
  reportThreshold: 3,
  rateLimitPerMinute: 10,
} as const;

export const COMMENT_MIN = 3;
export const TEXT_MAX = 500;

/** Motivo de ocultamiento: la corrección de asistencia se revierte sola; la moderación, no. */
export const HiddenReason = {
  ATTENDANCE_CORRECTED: 'attendance_corrected',
  MODERATION: 'moderation',
} as const;
export type HiddenReason = (typeof HiddenReason)[keyof typeof HiddenReason];

/**
 * Texto plano: recorta y colapsa los espacios de cada línea, conserva saltos de línea simples. No
 * interpreta HTML (se guarda tal cual y la app lo muestra como texto). Vacío → null.
 */
export function normalizeText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized.length === 0 ? null : normalized;
}

/** Dentro del plazo para valorar o editar: `windowDays` desde que la reserva quedó ATTENDED. */
export function withinReviewWindow(attendedAt: Date, nowMs: number, windowDays: number): boolean {
  return nowMs <= attendedAt.getTime() + windowDays * 24 * 3600 * 1000;
}

/** Con `threshold` reportes abiertos distintos, lo visible pasa a revisión (sigue visible). */
export function reachesReportThreshold(openReports: number, threshold: number): boolean {
  return openReports >= threshold;
}
