import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';

export const IMAGE_STORAGE = Symbol('IMAGE_STORAGE');

/**
 * Almacenamiento de imágenes (Fase 14). S3 compatible: SeaweedFS en local, Cloudflare R2 en
 * producción. Las claves son aleatorias (imposibles de adivinar) y los objetos, públicos de lectura
 * a través de `publicUrl`. Nunca se llama dentro de una transacción de la base (regla 12).
 */
export interface ImageStorage {
  readonly enabled: boolean;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Para servir las imágenes desde la API en desarrollo. null si no existe. */
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(keys: string[]): Promise<void>;
  publicUrl(key: string): string;
}

/** Prefijo de la API que sirve las imágenes cuando no hay `MEDIA_PUBLIC_BASE_URL` (solo desarrollo). */
export const MEDIA_ROUTE = 'media';

@Injectable()
export class S3ImageStorage implements ImageStorage, OnModuleInit {
  private readonly logger = new Logger(S3ImageStorage.name);
  private readonly client: S3Client | null;
  private readonly bucket: string | null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const s = config.storage;
    this.bucket = s.bucket;
    this.client =
      s.bucket && s.accessKeyId && s.secretAccessKey
        ? new S3Client({
            region: s.region,
            endpoint: s.endpoint ?? undefined,
            forcePathStyle: s.forcePathStyle,
            credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
          })
        : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** En desarrollo y pruebas crea el bucket si falta; en producción debe existir. */
  async onModuleInit(): Promise<void> {
    if (!this.client || !this.bucket || this.config.isProduction) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (error) {
        this.logger.warn(
          { err: (error as Error).name },
          'No se pudo preparar el bucket de imágenes (¿está levantado el almacenamiento?)',
        );
      }
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.require().send(
      new PutObjectCommand({
        Bucket: this.bucket!,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Las claves no cambian nunca: caché larga e inmutable.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    try {
      const res = await this.require().send(
        new GetObjectCommand({ Bucket: this.bucket!, Key: key }),
      );
      const bytes = await res.Body!.transformToByteArray();
      return {
        body: Buffer.from(bytes),
        contentType: res.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (error instanceof NoSuchKey || (error as { name?: string }).name === 'NoSuchKey')
        return null;
      throw error;
    }
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.require().send(
      new DeleteObjectsCommand({
        Bucket: this.bucket!,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }

  publicUrl(key: string): string {
    const base = this.config.storage.publicBaseUrl;
    return base ? `${base}/${key}` : `/api/v1/${MEDIA_ROUTE}/${key}`;
  }

  private require(): S3Client {
    if (!this.client) throw new Error('Almacenamiento de imágenes no configurado');
    return this.client;
  }
}
