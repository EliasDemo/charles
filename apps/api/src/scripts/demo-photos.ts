import { PrismaService } from '../common/prisma/prisma.service';
import { ImagesService } from '../modules/images/images.service';
import { runDevTool } from './dev-cli';
import { DevToolError } from './dev-tools';

/**
 * `pnpm --filter api dev:demo-photos [--per-style N] [--clean]`
 *
 * Fotos de DEMOSTRACIÓN para las galerías (solo desarrollo; nunca en producción). Usa la API
 * oficial de Pexels (https://www.pexels.com/api/), con licencia libre, sin paquetes externos:
 * solo `fetch` a api.pexels.com y descarga desde images.pexels.com. Cada foto:
 * - pasa por el procesamiento normal (se valida que sea imagen, se re-codifica, sin metadatos);
 * - queda marcada `isDemo` (la app la muestra como "Ejemplo"), nunca como trabajo confirmado;
 * - guarda fotógrafo y enlace (`demoSource`) para atribuirla o retirarla.
 * `--clean` borra todas las fotos de demostración.
 * Requiere PEXELS_API_KEY en apps/api/.env (nunca en el repositorio).
 */

const QUERIES: Record<string, string> = {
  fade_low: 'low fade haircut man',
  fade_mid: 'mid fade haircut man',
  fade_high: 'high fade haircut man',
  taper: 'taper haircut man',
  buzz_cut: 'buzz cut man',
  crop: 'textured crop haircut man',
  pompadour: 'pompadour hairstyle man',
  classic_scissors: 'classic men haircut scissors',
  mullet: 'modern mullet haircut',
  hair_design: 'hair design lines barber',
  quiff: 'quiff hairstyle man',
  undercut: 'undercut hairstyle man',
  side_part: 'side part haircut man',
  slick_back: 'slicked back hair man',
  curly_top: 'curly top fade haircut',
};

const API_HOST = 'api.pexels.com';
const IMAGE_HOST = 'images.pexels.com';
const MAX_BYTES = 8 * 1024 * 1024;

interface PexelsPhoto {
  id: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt?: string;
  src: { large: string };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function search(key: string, query: string, perPage: number): Promise<PexelsPhoto[]> {
  const url = new URL(`https://${API_HOST}/v1/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('orientation', 'portrait');
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) throw new DevToolError(`Pexels respondió ${res.status} al buscar "${query}".`);
  const body = (await res.json()) as { photos?: PexelsPhoto[] };
  return body.photos ?? [];
}

/** Descarga solo de images.pexels.com por https, con tope de tamaño. */
async function download(src: string): Promise<Buffer | null> {
  const url = new URL(src);
  if (url.protocol !== 'https:' || url.hostname !== IMAGE_HOST) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.length > MAX_BYTES ? null : buffer;
}

void runDevTool(async (app) => {
  const images = app.get(ImagesService);
  if (process.argv.includes('--clean')) {
    console.warn(`Fotos de demostración borradas: ${await images.deleteDemoImages()}.`);
    return;
  }
  const key = process.env.PEXELS_API_KEY;
  if (!key)
    throw new DevToolError(
      'Falta PEXELS_API_KEY en apps/api/.env (clave gratis en pexels.com/api).',
    );
  const perStyle = Math.min(Math.max(Number(arg('--per-style') ?? 3), 1), 10);
  const prisma = app.get(PrismaService);

  const shops = await prisma.barbershop.findMany({
    where: { deletedAt: null, status: { in: ['OPEN', 'TEMPORARILY_CLOSED'] } },
    select: {
      id: true,
      name: true,
      members: { where: { role: 'OWNER' }, select: { userId: true }, take: 1 },
    },
  });
  const usable = shops.filter((s) => s.members.length > 0);
  if (usable.length === 0)
    throw new DevToolError('No hay barberías visibles con dueño: crea una primero.');
  const styles = await prisma.serviceStyle.findMany({
    where: { key: { in: Object.keys(QUERIES) }, isActive: true },
    select: { id: true, key: true, name: true },
  });

  let created = 0;
  let turn = 0;
  for (const style of styles) {
    const photos = await search(key, QUERIES[style.key]!, perStyle);
    for (const photo of photos) {
      const already = await prisma.image.count({
        where: { isDemo: true, deletedAt: null, demoSource: { path: ['id'], equals: photo.id } },
      });
      if (already) continue;
      const file = await download(photo.src.large);
      if (!file) continue;
      const shop = usable[turn++ % usable.length]!;
      try {
        await images.createDemoImage({
          file,
          barbershopId: shop.id,
          uploadedById: shop.members[0]!.userId,
          styleIds: [style.id],
          caption: `Ejemplo: ${style.name}`,
          source: {
            provider: 'pexels',
            id: photo.id,
            url: photo.url,
            photographer: photo.photographer,
            photographerUrl: photo.photographer_url,
          },
        });
        created++;
      } catch {
        // Imagen inválida o almacenamiento caído: se salta (el procesamiento la rechazó).
      }
    }
    console.warn(`${style.name}: listo.`);
  }
  console.warn(`Fotos de demostración creadas: ${created} (marcadas como demo, con su autor).`);
});
