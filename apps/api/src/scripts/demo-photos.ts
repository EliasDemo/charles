import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PrismaService } from '../common/prisma/prisma.service';
import { ImagesService } from '../modules/images/images.service';
import { runDevTool } from './dev-cli';
import { DevToolError } from './dev-tools';

/**
 * Fotos de DEMOSTRACIÓN para las galerías (solo desarrollo; nunca en producción).
 *
 *   pnpm --filter api dev:demo-photos [--per-style N]       (API oficial de Pixabay)
 *   pnpm --filter api dev:demo-photos --from-folder <ruta>  (fotos descargadas a mano)
 *   pnpm --filter api dev:demo-photos --clean               (borra todas las de demostración)
 *
 * Pixabay (https://pixabay.com/api/docs/): pide descargar las imágenes al servidor (no enlazarlas),
 * mostrar su origen y no hacer descargas masivas. Sin paquetes externos: solo `fetch` a
 * pixabay.com/api y descargas desde pixabay.com o cdn.pixabay.com por https, con tope de tamaño.
 *
 * Desde carpeta: archivos `<clave-del-corte>__<autor>.jpg` (por ejemplo `fade_low__Juan Perez.jpg`);
 * el autor y la fuente quedan en `demoSource`.
 *
 * Toda foto pasa por el procesamiento normal (se valida que sea imagen, se re-codifica a WebP, sin
 * metadatos), queda marcada `isDemo` (la app la muestra como "Ejemplo") y nunca cuenta como trabajo
 * confirmado. Requiere PIXABAY_API_KEY en apps/api/.env (nunca en el repositorio).
 */

const QUERIES: Record<string, string> = {
  fade_low: 'low fade haircut',
  fade_mid: 'fade haircut man',
  fade_high: 'high fade haircut',
  taper: 'taper haircut',
  buzz_cut: 'buzz cut man',
  crop: 'crop haircut man',
  pompadour: 'pompadour hairstyle',
  classic_scissors: 'men haircut barber scissors',
  mullet: 'mullet hairstyle',
  hair_design: 'barber hair design',
  quiff: 'quiff hairstyle',
  undercut: 'undercut hairstyle',
  side_part: 'side part hairstyle man',
  slick_back: 'slicked back hair man',
  curly_top: 'curly hair fade man',
};

const API_URL = 'https://pixabay.com/api/';
const IMAGE_HOSTS = new Set(['pixabay.com', 'cdn.pixabay.com']);
const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

interface PixabayHit {
  id: number;
  pageURL: string;
  largeImageURL: string;
  user: string;
  user_id: number;
}

interface DemoPhoto {
  file: Buffer;
  styleKey: string;
  source: { provider: string; id?: number; url?: string; author: string; authorUrl?: string };
  dedupeId?: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function search(key: string, query: string, perPage: number): Promise<PixabayHit[]> {
  const url = new URL(API_URL);
  url.searchParams.set('key', key);
  url.searchParams.set('q', query);
  url.searchParams.set('image_type', 'photo');
  url.searchParams.set('orientation', 'vertical');
  url.searchParams.set('safesearch', 'true');
  url.searchParams.set('per_page', String(Math.max(3, perPage)));
  const res = await fetch(url);
  if (!res.ok) throw new DevToolError(`Pixabay respondió ${res.status} al buscar "${query}".`);
  const body = (await res.json()) as { hits?: PixabayHit[] };
  return (body.hits ?? []).slice(0, perPage);
}

/** Descarga solo de los dominios oficiales de Pixabay, por https y con tope de tamaño. */
async function download(src: string): Promise<Buffer | null> {
  const url = new URL(src);
  if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname)) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.length > MAX_BYTES ? null : buffer;
}

async function fromPixabay(
  key: string,
  styleKeys: string[],
  perStyle: number,
): Promise<DemoPhoto[]> {
  const photos: DemoPhoto[] = [];
  for (const styleKey of styleKeys) {
    for (const hit of await search(key, QUERIES[styleKey]!, perStyle)) {
      const file = await download(hit.largeImageURL);
      if (!file) continue;
      photos.push({
        file,
        styleKey,
        dedupeId: hit.id,
        source: {
          provider: 'pixabay',
          id: hit.id,
          url: hit.pageURL,
          author: hit.user,
          authorUrl: `https://pixabay.com/users/${encodeURIComponent(hit.user)}-${hit.user_id}/`,
        },
      });
    }
  }
  return photos;
}

async function fromFolder(folder: string, styleKeys: Set<string>): Promise<DemoPhoto[]> {
  const photos: DemoPhoto[] = [];
  for (const name of await readdir(folder)) {
    if (!IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const [styleKey, author] = name.slice(0, -extname(name).length).split('__');
    if (!styleKey || !styleKeys.has(styleKey)) {
      console.warn(`Se omite ${name}: el nombre debe empezar con la clave de un corte.`);
      continue;
    }
    photos.push({
      file: await readFile(join(folder, name)),
      styleKey,
      source: { provider: 'carpeta', author: author?.trim() || 'sin autor' },
    });
  }
  return photos;
}

void runDevTool(async (app) => {
  const images = app.get(ImagesService);
  if (process.argv.includes('--clean')) {
    console.warn(`Fotos de demostración borradas: ${await images.deleteDemoImages()}.`);
    return;
  }
  const prisma = app.get(PrismaService);
  const shops = await prisma.barbershop.findMany({
    where: { deletedAt: null, status: { in: ['OPEN', 'TEMPORARILY_CLOSED'] } },
    select: {
      id: true,
      members: { where: { role: 'OWNER' }, select: { userId: true }, take: 1 },
    },
  });
  const usable = shops.filter((s) => s.members.length > 0);
  if (usable.length === 0) {
    throw new DevToolError('No hay barberías visibles con dueño: crea una primero.');
  }
  const styles = await prisma.serviceStyle.findMany({
    where: { key: { in: Object.keys(QUERIES) }, isActive: true },
    select: { id: true, key: true, name: true },
  });
  const styleByKey = new Map(styles.map((s) => [s.key, s]));

  const folder = arg('--from-folder');
  let photos: DemoPhoto[];
  if (folder) {
    photos = await fromFolder(folder, new Set(styleByKey.keys()));
  } else {
    const key = process.env.PIXABAY_API_KEY;
    if (!key) {
      throw new DevToolError(
        'Falta PIXABAY_API_KEY en apps/api/.env (o usa --from-folder <ruta>).',
      );
    }
    const perStyle = Math.min(Math.max(Number(arg('--per-style') ?? 3), 1), 10);
    photos = await fromPixabay(key, [...styleByKey.keys()], perStyle);
  }

  let created = 0;
  let turn = 0;
  for (const photo of photos) {
    if (photo.dedupeId !== undefined) {
      const already = await prisma.image.count({
        where: {
          isDemo: true,
          deletedAt: null,
          demoSource: { path: ['id'], equals: photo.dedupeId },
        },
      });
      if (already) continue;
    }
    const style = styleByKey.get(photo.styleKey)!;
    const shop = usable[turn++ % usable.length]!;
    try {
      await images.createDemoImage({
        file: photo.file,
        barbershopId: shop.id,
        uploadedById: shop.members[0]!.userId,
        styleIds: [style.id],
        caption: `Ejemplo: ${style.name} · foto de ${photo.source.author}${
          photo.source.provider === 'pixabay' ? ' en Pixabay' : ''
        }`,
        source: photo.source,
      });
      created++;
    } catch {
      // Imagen inválida o almacenamiento caído: el procesamiento la rechazó; se salta.
    }
  }
  console.warn(
    `Fotos de demostración creadas: ${created} de ${photos.length} (marcadas como demo, con su autor).`,
  );
});
