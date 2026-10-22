/**
 * Catálogo de beneficios de los planes (Fase 15, ADR 0004). Las claves y su tipo viven en el
 * código; qué plan tiene cada una y con qué valor, en la base (`plan_entitlements`).
 *
 * - **Límite:** número máximo (null = ilimitado; sin fila = 0, no incluido).
 * - **Interruptor:** 1 incluido, 0 o sin fila = no incluido.
 *
 * Ningún módulo pregunta "¿qué plan tiene?": pregunta "¿tiene este derecho?" o "¿cuál es el
 * límite?" a `EntitlementsService`.
 */

export type EntitlementKind = 'LIMIT' | 'TOGGLE';

export interface EntitlementDefinition {
  key: EntitlementKey;
  kind: EntitlementKind;
  label: string;
}

export const ENTITLEMENT_KEYS = [
  'barbers',
  'gallery_photos',
  'featured_days_month',
  'messages_month',
  'crm_clients',
  'local_sales_month',
  'promotions',
  'client_ranking',
  'reports_full',
  'reports_export',
  'memberships',
  'verified_badge',
  'priority_support',
] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export const ENTITLEMENT_CATALOG: readonly EntitlementDefinition[] = [
  { key: 'barbers', kind: 'LIMIT', label: 'Barberos activos' },
  { key: 'gallery_photos', kind: 'LIMIT', label: 'Fotos en la galería' },
  { key: 'featured_days_month', kind: 'LIMIT', label: 'Días destacados por mes' },
  { key: 'messages_month', kind: 'LIMIT', label: 'Mensajes enviados a personas por mes' },
  { key: 'crm_clients', kind: 'LIMIT', label: 'Clientes registrados en el panel' },
  { key: 'local_sales_month', kind: 'LIMIT', label: 'Ventas en el local por mes' },
  { key: 'promotions', kind: 'TOGGLE', label: 'Promociones y cupones propios' },
  { key: 'client_ranking', kind: 'TOGGLE', label: 'Ranking de clientes y promociones por nivel' },
  { key: 'reports_full', kind: 'TOGGLE', label: 'Reportes completos de caja y barberos' },
  { key: 'reports_export', kind: 'TOGGLE', label: 'Exportar reportes (CSV)' },
  { key: 'memberships', kind: 'TOGGLE', label: 'Vender membresías a clientes' },
  { key: 'verified_badge', kind: 'TOGGLE', label: 'Insignia "Verificada"' },
  { key: 'priority_support', kind: 'TOGGLE', label: 'Soporte prioritario' },
];

const KIND = new Map(ENTITLEMENT_CATALOG.map((d) => [d.key, d.kind]));

export const entitlementKind = (key: string): EntitlementKind | undefined =>
  KIND.get(key as EntitlementKey);

export const isEntitlementKey = (key: string): key is EntitlementKey =>
  KIND.has(key as EntitlementKey);

/** Valores de un plan: clave → valor (límite: número o null ilimitado; interruptor: 0/1). */
export type EntitlementValues = ReadonlyMap<string, number | null>;

/**
 * Límite efectivo. `values` null = sin planes configurados (comportamiento anterior a la Fase 15):
 * todo ilimitado.
 */
export function limitOf(values: EntitlementValues | null, key: EntitlementKey): number | null {
  if (!values) return null;
  if (!values.has(key)) return 0;
  return values.get(key) ?? null;
}

export function hasFeature(values: EntitlementValues | null, key: EntitlementKey): boolean {
  if (!values) return true;
  return (values.get(key) ?? 0) > 0;
}

/** Normaliza lo que envía ADMIN: interruptores a 0/1, límites ≥ 0 o null. */
export function normalizeEntitlement(
  key: EntitlementKey,
  value: number | boolean | null,
): number | null {
  if (KIND.get(key) === 'TOGGLE')
    return value === true || (typeof value === 'number' && value > 0) ? 1 : 0;
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? null : 0;
  return Math.max(0, Math.floor(value));
}
