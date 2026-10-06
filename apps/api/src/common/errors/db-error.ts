import { Prisma } from '../../generated/prisma/client';

/** Códigos de un error de base de datos. Nunca incluye mensajes ni valores (pueden tener datos personales). */
export interface DbErrorInfo {
  /** Código de Prisma (por ejemplo `P2002`, `P2028`), o null. */
  prismaCode: string | null;
  /** SQLSTATE de PostgreSQL (por ejemplo `40P01`), o null. */
  pgCode: string | null;
  /** Restricción violada, si PostgreSQL la informa. */
  constraint: string | null;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Busca el SQLSTATE y la restricción dentro del error del adaptador (anidado en `meta`/`cause`). */
function findPgDetails(
  value: unknown,
  depth = 0,
): { pgCode: string | null; constraint: string | null } {
  if (depth > 5 || typeof value !== 'object' || value === null)
    return { pgCode: null, constraint: null };
  const record = value as Record<string, unknown>;
  const code = [record.originalCode, record.code].find(
    (c): c is string => typeof c === 'string' && SQLSTATE.test(c),
  );
  const constraint =
    typeof record.constraint === 'string'
      ? record.constraint
      : typeof (record.constraint as { index?: unknown } | undefined)?.index === 'string'
        ? (record.constraint as { index: string }).index
        : null;
  if (code) return { pgCode: code, constraint };
  for (const key of ['meta', 'driverAdapterError', 'cause']) {
    const found = findPgDetails(record[key], depth + 1);
    if (found.pgCode) return { pgCode: found.pgCode, constraint: found.constraint ?? constraint };
  }
  return { pgCode: null, constraint };
}

export function dbErrorInfo(error: unknown): DbErrorInfo | null {
  const isPrisma =
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    (error instanceof Error && error.name === 'DriverAdapterError');
  if (!isPrisma) return null;
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
  // El `code` de primer nivel es el de Prisma (P2039 tiene el formato de un SQLSTATE): el de
  // PostgreSQL viene anidado en `meta.driverAdapterError.cause` o en `cause`.
  const nested = error as unknown as { meta?: unknown; cause?: unknown };
  const fromMeta = findPgDetails(nested.meta);
  const { pgCode, constraint } = fromMeta.pgCode ? fromMeta : findPgDetails(nested.cause);
  return { prismaCode, pgCode, constraint };
}

/** Errores de contención: se reintentan y, si persisten, son 503 reintentables (nunca 500). */
export const CONTENTION_PG_CODES = ['40P01', '40001', '55P03'] as const; // deadlock, serialización, lock_timeout
export const CONTENTION_PRISMA_CODES = ['P2034', 'P2028'] as const; // conflicto de escritura, transacción expirada

export function isContention(info: DbErrorInfo | null): boolean {
  if (!info) return false;
  return (
    (info.pgCode !== null && (CONTENTION_PG_CODES as readonly string[]).includes(info.pgCode)) ||
    (info.prismaCode !== null &&
      (CONTENTION_PRISMA_CODES as readonly string[]).includes(info.prismaCode))
  );
}

/** Violación de una restricción de exclusión (SQLSTATE 23P01), por ejemplo `bookings_no_overlap`. */
export function isExclusionViolation(info: DbErrorInfo | null): boolean {
  return info?.pgCode === '23P01';
}
