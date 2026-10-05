import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Paginación por cursor (CLAUDE.md §10): `?limit=&cursor=` → `{ items, nextCursor }`. */
export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Valor de nextCursor de la página anterior.',
  })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Argumentos de Prisma para una página ordenada por `id` (UUID v7, ordenado por tiempo).
 * Se pide un elemento de más para saber si hay página siguiente.
 */
export function pageArgs(query: PaginationQueryDto): {
  take: number;
  orderBy: { id: 'asc' };
  where: { id?: { gt: string } };
} {
  return {
    take: (query.limit ?? DEFAULT_PAGE_SIZE) + 1,
    orderBy: { id: 'asc' },
    where: query.cursor ? { id: { gt: query.cursor } } : {},
  };
}

export function toPage<Row extends { id: string }, T>(
  rows: Row[],
  query: PaginationQueryDto,
  map: (row: Row) => T,
): Page<T> {
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: pageRows.map(map),
    nextCursor: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
  };
}
