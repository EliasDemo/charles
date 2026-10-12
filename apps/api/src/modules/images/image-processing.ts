import { HttpStatus } from '@nestjs/common';
import sharp from 'sharp';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * Procesamiento de imágenes (Fase 14) con sharp, en memoria:
 * - valida el **tipo real** por el contenido (no por la extensión ni el Content-Type): JPEG, PNG
 *   o WebP;
 * - aplica la orientación EXIF y **elimina todos los metadatos** (EXIF, GPS, ICC): sharp no los
 *   copia salvo que se pida con `withMetadata`;
 * - genera las variantes en WebP.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
/** Evita bombas de descompresión: una imagen de más píxeles se rechaza. */
const MAX_INPUT_PIXELS = 50_000_000;

export type ImageKind =
  | 'BARBERSHOP_LOGO'
  | 'BARBERSHOP_COVER'
  | 'BARBER_PHOTO'
  | 'GALLERY'
  /** Foto de perfil de la cuenta: se guarda en `users.photo_variants`, no en `images`. */
  | 'USER_PHOTO';

export interface Variant {
  name: 'thumb' | 'large' | 'square';
  buffer: Buffer;
  width: number;
  height: number;
}

/** Variantes por tipo: galería y portada (400 y 1600 px de ancho); logo y fotos (cuadrado de 512). */
const PLAN: Record<ImageKind, { name: Variant['name']; width: number; square?: boolean }[]> = {
  GALLERY: [
    { name: 'thumb', width: 400 },
    { name: 'large', width: 1600 },
  ],
  BARBERSHOP_COVER: [
    { name: 'thumb', width: 400 },
    { name: 'large', width: 1600 },
  ],
  BARBERSHOP_LOGO: [{ name: 'square', width: 512, square: true }],
  BARBER_PHOTO: [{ name: 'square', width: 512, square: true }],
  USER_PHOTO: [{ name: 'square', width: 512, square: true }],
};

const invalidImage = (reason: string): AppException =>
  new AppException(ErrorCode.INVALID_IMAGE, reason, HttpStatus.BAD_REQUEST);

export async function processImage(input: Buffer, kind: ImageKind): Promise<Variant[]> {
  if (input.length === 0) throw invalidImage('El archivo está vacío.');
  if (input.length > MAX_UPLOAD_BYTES) {
    throw new AppException(
      ErrorCode.PAYLOAD_TOO_LARGE,
      'La imagen supera los 10 MB.',
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }
  let format: string | undefined;
  try {
    ({ format } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata());
  } catch {
    throw invalidImage('El archivo no es una imagen válida.');
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) {
    throw invalidImage('Formato no admitido: sube una imagen JPEG, PNG o WebP.');
  }
  const variants: Variant[] = [];
  for (const step of PLAN[kind]) {
    const pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate() // aplica la orientación EXIF antes de descartarla
      .resize(
        step.square
          ? { width: step.width, height: step.width, fit: 'cover', position: 'attention' }
          : { width: step.width, withoutEnlargement: true },
      )
      .webp({ quality: 82 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    variants.push({ name: step.name, buffer: data, width: info.width, height: info.height });
  }
  return variants;
}
