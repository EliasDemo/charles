import { containedIn, intersect, overlaps, subtract, union } from './intervals';

const i = (start: number, end: number) => ({ start, end });

describe('intervalos [inicio, fin)', () => {
  it('union: ordena, descarta vacíos y fusiona solapados y contiguos', () => {
    expect(union([i(5, 7), i(1, 3), i(3, 4), i(6, 9), i(2, 2)])).toEqual([i(1, 4), i(5, 9)]);
    expect(union([])).toEqual([]);
  });

  it('intersect', () => {
    expect(intersect([i(0, 10)], [i(2, 4), i(8, 12)])).toEqual([i(2, 4), i(8, 10)]);
    expect(intersect([i(0, 5)], [i(5, 10)])).toEqual([]); // solo se tocan
    expect(intersect([i(0, 5)], [])).toEqual([]);
  });

  it('subtract', () => {
    expect(subtract([i(0, 10)], [i(2, 3), i(5, 7)])).toEqual([i(0, 2), i(3, 5), i(7, 10)]);
    expect(subtract([i(0, 10)], [i(-5, 15)])).toEqual([]);
    expect(subtract([i(0, 10)], [i(10, 12)])).toEqual([i(0, 10)]); // contiguo: no resta
    expect(subtract([i(0, 4), i(6, 10)], [i(3, 7)])).toEqual([i(0, 3), i(7, 10)]);
    expect(subtract([i(0, 10)], [])).toEqual([i(0, 10)]);
  });

  it('containedIn y overlaps', () => {
    expect(containedIn(i(2, 4), [i(0, 4)])).toBe(true);
    expect(containedIn(i(2, 5), [i(0, 4)])).toBe(false);
    expect(overlaps(i(0, 5), i(5, 10))).toBe(false);
    expect(overlaps(i(0, 5), i(4, 10))).toBe(true);
  });
});
