import type { ImageStorage } from './image-storage';
import type { Variant } from './image-processing';

/** Forma de `images.variants` en la base. */
export type StoredVariants = Partial<
  Record<Variant['name'], { key: string; width: number; height: number }>
>;

export function variantKeys(variants: unknown): string[] {
  return Object.values((variants ?? {}) as StoredVariants)
    .map((v) => v?.key)
    .filter((k): k is string => typeof k === 'string');
}

/** URL pública de una variante (o de la primera disponible). */
export function variantUrl(
  storage: ImageStorage,
  variants: unknown,
  name: Variant['name'],
): string | null {
  const v = (variants ?? {}) as StoredVariants;
  const chosen = v[name] ?? v.large ?? v.square ?? v.thumb;
  return chosen ? storage.publicUrl(chosen.key) : null;
}
