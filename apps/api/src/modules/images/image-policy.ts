/** Valores por defecto de la Fase 14 (ajustes `images.*` en app_settings). */
export const IMAGE_DEFAULTS = {
  galleryMaxPerBarber: 60,
  pinnedMaxPerBarber: 6,
  reportHideThreshold: 3,
  uploadRateLimitPerMinute: 20,
  /** Fijo (ADR 0004): estilos por foto. */
  stylesPerImageMax: 3,
  /** Fijo (no es un ajuste): especialidades por barbero. */
  specialtiesMax: 5,
} as const;

/** Clave de estilo: minúsculas, dígitos y guion bajo; empieza por letra. */
export const STYLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/** Una foto se oculta sola cuando sus reportes abiertos llegan al umbral. */
export function isHiddenByReports(openReports: number, threshold: number): boolean {
  return openReports >= threshold;
}
