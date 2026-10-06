/**
 * Intervalos semiabiertos [start, end) en milisegundos UTC. Funciones puras.
 * Dos intervalos que solo se tocan (a.end === b.start) NO se solapan: dos citas contiguas son válidas.
 */
export interface Interval {
  start: number;
  end: number;
}

/** Ordena, descarta vacíos y fusiona los que se solapan o se tocan. */
export function union(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const result: Interval[] = [];
  for (const current of sorted) {
    const last = result[result.length - 1];
    if (last && current.start <= last.end) last.end = Math.max(last.end, current.end);
    else result.push({ ...current });
  }
  return result;
}

/** Intersección de dos conjuntos de intervalos. */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = union(a);
  const right = union(b);
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const x = left[i]!;
    const y = right[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) result.push({ start, end });
    if (x.end < y.end) i++;
    else j++;
  }
  return result;
}

/** `a` menos `b`. */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const removals = union(b);
  const result: Interval[] = [];
  for (const base of union(a)) {
    let cursor = base.start;
    for (const r of removals) {
      if (r.end <= cursor) continue;
      if (r.start >= base.end) break;
      if (r.start > cursor) result.push({ start: cursor, end: r.start });
      cursor = Math.max(cursor, r.end);
      if (cursor >= base.end) break;
    }
    if (cursor < base.end) result.push({ start: cursor, end: base.end });
  }
  return result;
}

/** ¿`inner` cabe completo en alguno de los intervalos? */
export function containedIn(inner: Interval, intervals: readonly Interval[]): boolean {
  return intervals.some((i) => i.start <= inner.start && inner.end <= i.end);
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
