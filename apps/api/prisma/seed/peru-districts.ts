import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '../../src/generated/prisma/client';

type Row = [string, string, string, string, number | null, number | null];

/**
 * Distritos del Perú (UBIGEO del INEI) con su punto central, para elegir provincia y distrito de
 * una lista fija y calcular distancias. Fuente y licencia: data/PERU-DISTRICTS-LICENSE.txt.
 * Idempotente: solo crea los que faltan.
 */
export async function seedPeruDistricts(prisma: PrismaClient): Promise<number> {
  const existing = await prisma.peruDistrict.count();
  const rows = JSON.parse(
    readFileSync(join(__dirname, 'data', 'peru-districts.json'), 'utf8'),
  ) as Row[];
  if (existing >= rows.length) return 0;
  const { count } = await prisma.peruDistrict.createMany({
    data: rows.map(([ubigeo, department, province, district, latitude, longitude]) => ({
      ubigeo,
      department,
      province,
      district,
      latitude,
      longitude,
    })),
    skipDuplicates: true,
  });
  return count;
}
