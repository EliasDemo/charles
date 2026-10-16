import type { PrismaService } from '../../common/prisma/prisma.service';
import type { ImageStorage } from './image-storage';
import { variantUrl } from './image-variants';

export interface BarbershopMedia {
  logoUrl: string | null;
  coverUrl: string | null;
  coverThumbUrl: string | null;
}

export const NO_MEDIA: BarbershopMedia = { logoUrl: null, coverUrl: null, coverThumbUrl: null };

/** Logo y portada vigentes de varias barberías (por lotes). Las que no tienen, no aparecen. */
export async function barbershopMedia(
  prisma: Pick<PrismaService, 'image'>,
  storage: ImageStorage,
  barbershopIds: string[],
): Promise<Map<string, BarbershopMedia>> {
  const result = new Map<string, BarbershopMedia>();
  if (barbershopIds.length === 0) return result;
  const images = await prisma.image.findMany({
    where: {
      barbershopId: { in: barbershopIds },
      kind: { in: ['BARBERSHOP_LOGO', 'BARBERSHOP_COVER'] },
      deletedAt: null,
      removedAt: null,
    },
    select: { barbershopId: true, kind: true, variants: true },
  });
  for (const image of images) {
    if (!image.barbershopId) continue;
    const media = result.get(image.barbershopId) ?? { ...NO_MEDIA };
    if (image.kind === 'BARBERSHOP_LOGO') {
      media.logoUrl = variantUrl(storage, image.variants, 'square');
    } else {
      media.coverUrl = variantUrl(storage, image.variants, 'large');
      media.coverThumbUrl = variantUrl(storage, image.variants, 'thumb');
    }
    result.set(image.barbershopId, media);
  }
  return result;
}
