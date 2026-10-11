import sharp from 'sharp';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MAX_UPLOAD_BYTES, processImage } from './image-processing';

/** JPEG de prueba con EXIF de GPS y orientación (como una foto de celular). */
async function jpegWithGps(width = 2400, height = 1200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: 'Telefono', Model: 'Prueba' },
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '12/1 2/1 3/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '77/1 1/1 2/1',
      },
    })
    .toBuffer();
}

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) {
      return error.code;
    }
    throw error;
  }
  return undefined;
};

describe('processImage', () => {
  it('la imagen de prueba sí trae EXIF con GPS (control)', async () => {
    const meta = await sharp(await jpegWithGps()).metadata();
    expect(meta.exif).toBeDefined();
    expect(meta.orientation).toBe(6);
    expect(meta.exif!.toString('latin1')).toContain('Telefono');
  });

  it('elimina todos los metadatos (EXIF, GPS) y convierte a WebP', async () => {
    const variants = await processImage(await jpegWithGps(), 'GALLERY');
    expect(variants.map((v) => v.name)).toEqual(['thumb', 'large']);
    for (const v of variants) {
      const meta = await sharp(v.buffer).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(v.buffer.toString('latin1')).not.toContain('Telefono');
    }
  });

  it('aplica la orientación EXIF antes de descartarla (2400×1200 rotada 90°)', async () => {
    const [thumb, large] = await processImage(await jpegWithGps(), 'GALLERY');
    expect(thumb).toMatchObject({ width: 400, height: 800 });
    expect(large).toMatchObject({ width: 1200, height: 2400 });
  });

  it('no agranda imágenes pequeñas', async () => {
    const small = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const [thumb, large] = await processImage(small, 'BARBERSHOP_COVER');
    expect(thumb).toMatchObject({ width: 300, height: 200 });
    expect(large).toMatchObject({ width: 300, height: 200 });
  });

  it('logo y foto del barbero: un cuadrado de 512', async () => {
    const webp = await sharp({
      create: { width: 900, height: 600, channels: 4, background: '#ffffff80' },
    })
      .webp()
      .toBuffer();
    for (const kind of ['BARBERSHOP_LOGO', 'BARBER_PHOTO'] as const) {
      const variants = await processImage(webp, kind);
      expect(variants).toHaveLength(1);
      expect(variants[0]).toMatchObject({ name: 'square', width: 512, height: 512 });
    }
  });

  it('rechaza un archivo que no es imagen aunque diga serlo (tipo falso)', async () => {
    const fake = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 1)]);
    expect(await codeOf(processImage(fake, 'GALLERY'))).toBe(ErrorCode.INVALID_IMAGE);
    const text = Buffer.from('<?php echo "no soy una foto"; ?>');
    expect(await codeOf(processImage(text, 'GALLERY'))).toBe(ErrorCode.INVALID_IMAGE);
  });

  it('rechaza formatos válidos pero no admitidos (GIF, SVG)', async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
      .gif()
      .toBuffer();
    expect(await codeOf(processImage(gif, 'GALLERY'))).toBe(ErrorCode.INVALID_IMAGE);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    expect(await codeOf(processImage(svg, 'GALLERY'))).toBe(ErrorCode.INVALID_IMAGE);
  });

  it('rechaza archivos vacíos y de más de 10 MB', async () => {
    expect(await codeOf(processImage(Buffer.alloc(0), 'GALLERY'))).toBe(ErrorCode.INVALID_IMAGE);
    expect(await codeOf(processImage(Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'GALLERY'))).toBe(
      ErrorCode.PAYLOAD_TOO_LARGE,
    );
  });
});
