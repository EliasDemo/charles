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
