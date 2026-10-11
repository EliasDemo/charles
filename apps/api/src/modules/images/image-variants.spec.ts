import type { ImageStorage } from './image-storage';
import { S3ImageStorage } from './image-storage';
import { variantKeys, variantUrl } from './image-variants';
import { isHiddenByReports } from './image-policy';
import type { AppConfig } from '../../common/config/env.validation';

const storage = { publicUrl: (key: string) => `https://img.example.com/${key}` } as ImageStorage;

describe('variantes de imagen', () => {
  it('lista las claves y tolera valores vacíos o inválidos', () => {
    expect(variantKeys({ thumb: { key: 'a', width: 1, height: 1 }, large: { key: 'b' } })).toEqual([
      'a',
      'b',
    ]);
    expect(variantKeys(null)).toEqual([]);
    expect(variantKeys({ thumb: { width: 1 } })).toEqual([]);
  });

  it('elige la variante pedida o la primera disponible', () => {
    const v = { square: { key: 's', width: 512, height: 512 } };
    expect(variantUrl(storage, v, 'square')).toBe('https://img.example.com/s');
    expect(variantUrl(storage, v, 'large')).toBe('https://img.example.com/s');
    expect(variantUrl(storage, { thumb: { key: 't' } }, 'large')).toBe('https://img.example.com/t');
    expect(variantUrl(storage, { large: { key: 'l' } }, 'thumb')).toBe('https://img.example.com/l');
    expect(variantUrl(storage, {}, 'large')).toBeNull();
    expect(variantUrl(storage, null, 'large')).toBeNull();
  });

  it('una foto se oculta al llegar al umbral de reportes abiertos', () => {
    expect(isHiddenByReports(2, 3)).toBe(false);
    expect(isHiddenByReports(3, 3)).toBe(true);
  });
});

describe('S3ImageStorage', () => {
  const config = (storageConfig: Partial<AppConfig['storage']>, isProduction = false) =>
    ({
      isProduction,
      storage: {
        bucket: null,
        endpoint: null,
        region: 'auto',
        accessKeyId: null,
        secretAccessKey: null,
        forcePathStyle: false,
        publicBaseUrl: null,
        ...storageConfig,
      },
    }) as AppConfig;

  it('sin bucket ni credenciales queda desactivado y no intenta conectarse', async () => {
    const s = new S3ImageStorage(config({}));
    expect(s.enabled).toBe(false);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    await expect(s.put('k', Buffer.from('x'), 'image/webp')).rejects.toThrow(/no configurado/);
  });

  it('en producción no crea el bucket', async () => {
    const s = new S3ImageStorage(
      config(
        {
          bucket: 'b',
          accessKeyId: 'id',
          secretAccessKey: 'secret',
          endpoint: 'https://s3.example.com',
        },
        true,
      ),
    );
    expect(s.enabled).toBe(true);
    await expect(s.onModuleInit()).resolves.toBeUndefined();
    await expect(s.delete([])).resolves.toBeUndefined();
  });

  it('URL pública: el dominio configurado o la ruta de la API', () => {
    expect(
      new S3ImageStorage(config({ publicBaseUrl: 'https://img.example.com' })).publicUrl(
        'img/a/b.webp',
      ),
    ).toBe('https://img.example.com/img/a/b.webp');
    expect(new S3ImageStorage(config({})).publicUrl('img/a/b.webp')).toBe(
      '/api/v1/media/img/a/b.webp',
    );
  });

  it('si el almacenamiento no responde al iniciar, solo lo registra', async () => {
    const s = new S3ImageStorage(
      config({
        bucket: 'charles-nada',
        accessKeyId: 'id',
        secretAccessKey: 'secret',
        endpoint: 'http://127.0.0.1:1',
        forcePathStyle: true,
      }),
    );
    await expect(s.onModuleInit()).resolves.toBeUndefined();
  });
});
