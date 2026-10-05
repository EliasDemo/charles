import { DEFAULT_PAGE_SIZE, pageArgs, toPage } from './pagination';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i}` }));

describe('paginación por cursor (CLAUDE.md §10)', () => {
  it('pide un elemento de más y filtra por cursor', () => {
    expect(pageArgs({})).toEqual({
      take: DEFAULT_PAGE_SIZE + 1,
      orderBy: { id: 'asc' },
      where: {},
    });
    expect(pageArgs({ limit: 5, cursor: 'abc' })).toEqual({
      take: 6,
      orderBy: { id: 'asc' },
      where: { id: { gt: 'abc' } },
    });
  });

  it('devuelve nextCursor solo si hay más elementos', () => {
    expect(toPage(rows(6), { limit: 5 }, (r) => r.id)).toEqual({
      items: ['id-0', 'id-1', 'id-2', 'id-3', 'id-4'],
      nextCursor: 'id-4',
    });
    expect(toPage(rows(5), { limit: 5 }, (r) => r.id).nextCursor).toBeNull();
    expect(toPage([], {}, (r: { id: string }) => r.id)).toEqual({ items: [], nextCursor: null });
  });
});
