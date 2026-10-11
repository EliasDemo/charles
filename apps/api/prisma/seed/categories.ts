import type { PrismaClient } from '../../src/generated/prisma/client';

/** ID fijo de "Otros": lo crea la migración 20261006000000 para asignarlo a servicios previos. */
export const OTHER_CATEGORY_ID = '01990000-0000-7000-8000-000000000909';

/**
 * Categorías de servicio iniciales (datos de referencia, no de prueba): se cargan en todos los
 * entornos. Idempotente: crea las que falten y nunca modifica las existentes.
 */
export const SERVICE_CATEGORIES = [
  { key: 'haircut', name: 'Corte de cabello', sortOrder: 10 },
  { key: 'beard', name: 'Barba', sortOrder: 20 },
  { key: 'haircut_beard', name: 'Corte y barba', sortOrder: 30 },
  { key: 'kids_haircut', name: 'Corte infantil', sortOrder: 40 },
  { key: 'hair_color', name: 'Tinte y color', sortOrder: 50 },
  { key: 'hair_treatment', name: 'Tratamiento capilar', sortOrder: 60 },
  { key: 'shave', name: 'Afeitado', sortOrder: 70 },
  { key: 'eyebrows', name: 'Cejas', sortOrder: 80 },
  { key: 'other', name: 'Otros', sortOrder: 90 },
] as const;

export type ServiceCategoryKey = (typeof SERVICE_CATEGORIES)[number]['key'];

/** Devuelve cuántas categorías se crearon. */
export async function seedServiceCategories(prisma: PrismaClient): Promise<number> {
  let created = 0;
  for (const category of SERVICE_CATEGORIES) {
    const exists = await prisma.serviceCategory.findUnique({ where: { key: category.key } });
    if (exists) continue;
    await prisma.serviceCategory.create({
      data: {
        ...(category.key === 'other' ? { id: OTHER_CATEGORY_ID } : {}),
        ...category,
      },
    });
    created++;
  }
  return created;
}

/**
 * Estilos iniciales por categoría (Fase 14): etiquetan fotos de la galería y especialidades del
 * barbero. Datos de referencia, idempotente: crea los que falten y nunca modifica los existentes.
 */
export const SERVICE_STYLES: { category: ServiceCategoryKey; key: string; name: string }[] = [
  { category: 'haircut', key: 'fade_low', name: 'Degradado bajo' },
  { category: 'haircut', key: 'fade_mid', name: 'Degradado medio' },
  { category: 'haircut', key: 'fade_high', name: 'Degradado alto' },
  { category: 'haircut', key: 'taper', name: 'Taper' },
  { category: 'haircut', key: 'buzz_cut', name: 'Corte al ras' },
  { category: 'haircut', key: 'crop', name: 'Crop texturizado' },
  { category: 'haircut', key: 'pompadour', name: 'Pompadour' },
  { category: 'haircut', key: 'classic_scissors', name: 'Clásico a tijera' },
  { category: 'haircut', key: 'mullet', name: 'Mullet' },
  { category: 'haircut', key: 'hair_design', name: 'Diseño y líneas' },
  { category: 'beard', key: 'beard_full', name: 'Barba completa' },
  { category: 'beard', key: 'beard_goatee', name: 'Candado' },
  { category: 'beard', key: 'beard_stubble', name: 'Barba corta' },
  { category: 'beard', key: 'beard_fade', name: 'Barba degradada' },
  { category: 'beard', key: 'beard_outline', name: 'Perfilado de barba' },
  { category: 'haircut_beard', key: 'combo_fade_beard', name: 'Degradado con barba' },
  { category: 'haircut_beard', key: 'combo_classic', name: 'Corte clásico con barba' },
  { category: 'kids_haircut', key: 'kids_classic', name: 'Infantil clásico' },
  { category: 'kids_haircut', key: 'kids_fade', name: 'Infantil degradado' },
  { category: 'kids_haircut', key: 'kids_design', name: 'Infantil con diseño' },
  { category: 'hair_color', key: 'color_platinum', name: 'Platinado' },
  { category: 'hair_color', key: 'color_highlights', name: 'Mechas y reflejos' },
  { category: 'hair_color', key: 'color_gray_cover', name: 'Cubrir canas' },
  { category: 'hair_color', key: 'color_fantasy', name: 'Color de fantasía' },
  { category: 'hair_treatment', key: 'treatment_keratin', name: 'Keratina' },
  { category: 'hair_treatment', key: 'treatment_hydration', name: 'Hidratación' },
  { category: 'hair_treatment', key: 'treatment_perm', name: 'Permanente y rizos' },
  { category: 'shave', key: 'shave_hot_towel', name: 'Afeitado con toalla caliente' },
  { category: 'shave', key: 'shave_classic', name: 'Afeitado clásico a navaja' },
  { category: 'eyebrows', key: 'eyebrows_shape', name: 'Perfilado de cejas' },
  { category: 'eyebrows', key: 'eyebrows_slit', name: 'Cortes en la ceja' },
  { category: 'other', key: 'other_facial', name: 'Limpieza facial' },
  { category: 'other', key: 'other_mask', name: 'Mascarilla' },
];

/** Devuelve cuántos estilos se crearon. Requiere las categorías. */
export async function seedServiceStyles(prisma: PrismaClient): Promise<number> {
  const categories = new Map(
    (await prisma.serviceCategory.findMany({ select: { id: true, key: true } })).map((c) => [
      c.key,
      c.id,
    ]),
  );
  let created = 0;
  for (const [i, style] of SERVICE_STYLES.entries()) {
    const categoryId = categories.get(style.category);
    if (!categoryId) throw new Error(`Falta la categoría ${style.category}`);
    const exists = await prisma.serviceStyle.findUnique({ where: { key: style.key } });
    if (exists) continue;
    await prisma.serviceStyle.create({
      data: { categoryId, key: style.key, name: style.name, sortOrder: (i + 1) * 10 },
    });
    created++;
  }
  return created;
}
