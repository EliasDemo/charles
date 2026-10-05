import type { Prisma } from '../../generated/prisma/client';

type Value = string | number | boolean | Date | null | undefined;

/**
 * Cambios para `audit_log` (CLAUDE.md §4.1):
 * - datos no personales (precio, duración, estado, roles...): valor anterior y nuevo;
 * - datos personales: solo el nombre del campo, nunca el valor.
 * Devuelve `null` si no hubo cambios.
 */
export function auditChanges<T extends Record<string, Value>>(
  before: T,
  after: Partial<T>,
  personalFields: readonly (keyof T)[] = [],
): Prisma.InputJsonObject | null {
  const values: Record<
    string,
    { from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null }
  > = {};
  const personal: string[] = [];

  for (const key of Object.keys(after) as (keyof T & string)[]) {
    const next = after[key];
    if (next === undefined) continue;
    const previous = before[key];
    if (normalize(previous) === normalize(next)) continue;
    if (personalFields.includes(key)) personal.push(key);
    else values[key] = { from: normalize(previous), to: normalize(next) };
  }

  if (Object.keys(values).length === 0 && personal.length === 0) return null;
  return {
    ...(Object.keys(values).length > 0 ? { values } : {}),
    ...(personal.length > 0 ? { personalFields: personal } : {}),
  };
}

function normalize(value: Value): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}
