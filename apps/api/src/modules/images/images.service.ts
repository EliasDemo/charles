import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { DEFAULT_PAGE_SIZE } from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { ImageKind } from '../../generated/prisma/enums';
import {
  BarbershopAccessService,
  forbidden,
  notFound,
} from '../barbershops/barbershop-access.service';
import { UsersService } from '../users/users.service';
import { type BarbershopMedia, barbershopMedia, NO_MEDIA } from './barbershop-media';
import type {
  BarberPhotoDto,
  CreateImageReportDto,
  GalleryImageDto,
  GalleryImageManageDto,
  GalleryManagePageDto,
  GalleryPageDto,
  GalleryQueryDto,
  GalleryUploadDto,
  ServiceStyleDto,
  SetSpecialtiesDto,
  UpdateGalleryImageDto,
} from './dto/image.dto';
import { type ImageKind as ProcessedKind, processImage } from './image-processing';
import { IMAGE_STORAGE, type ImageStorage } from './image-storage';
import { IMAGE_DEFAULTS, isHiddenByReports } from './image-policy';
import { type StoredVariants, variantKeys, variantUrl } from './image-variants';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { SERVICE_CURRENCY } from '../services/dto/service.dto';
import type { PortfolioItemDto } from '../career/dto/career.dto';
import type { FaceShape } from '../recommendations/face-shape';

const imageNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La imagen no existe.', HttpStatus.NOT_FOUND);

const barberNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El barbero no existe.', HttpStatus.NOT_FOUND);

const storageUnavailable = (): AppException =>
  new AppException(
    ErrorCode.STORAGE_UNAVAILABLE,
    'Las imágenes no están disponibles en este momento. Inténtalo más tarde.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );

const invalidField = (field: string, constraint: string): AppException =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: [constraint] }],
  );

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Clave aleatoria e imposible de adivinar (128 bits). */
const newKeyPrefix = (): string => `img/${randomBytes(16).toString('base64url')}`;

const galleryInclude = {
  barber: { select: { displayName: true } },
  service: {
    select: {
      id: true,
      name: true,
      priceAmount: true,
      currency: true,
      durationMinutes: true,
      isAvailable: true,
      deletedAt: true,
    },
  },
  styles: { select: { style: { select: { id: true, key: true, name: true, sortOrder: true } } } },
  _count: { select: { reports: { where: { status: { not: 'RESOLVED' as const } } } } },
} satisfies Prisma.ImageInclude;

type GalleryRow = Prisma.ImageGetPayload<{ include: typeof galleryInclude }>;

const portfolioInclude = {
  barbershop: { select: { name: true } },
  styles: { select: { style: { select: { id: true, key: true, name: true, sortOrder: true } } } },
  _count: { select: { reports: { where: { status: { not: 'RESOLVED' as const } } } } },
} satisfies Prisma.ImageInclude;

type PortfolioRow = Prisma.ImageGetPayload<{ include: typeof portfolioInclude }>;

type SingleKind = Exclude<ImageKind, 'GALLERY'>;

/**
 * Imágenes (Fase 14): logo y portada de la barbería, foto y galería del barbero, estilos,
 * especialidades y reportes. El procesamiento y el almacenamiento van **fuera** de las
 * transacciones (regla 12): primero se sube, luego se registra; si el registro falla, se borra lo
 * subido. Al reemplazar o borrar, los archivos viejos se borran después de confirmar.
 */
@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly users: UsersService,
  ) {}

  // ───────────── Foto de perfil de la cuenta ─────────────

  /** Sube o reemplaza la foto de perfil (cuadrado de 512 px). Los archivos viejos se borran al final. */
  async setUserPhoto(
    userId: string,
    file: Buffer | undefined,
    ip: string | null,
  ): Promise<{ photoUrl: string | null }> {
    const variants = await this.store(file, 'USER_PHOTO');
    let result: Awaited<ReturnType<UsersService['replacePhoto']>>;
    try {
      result = await this.users.replacePhoto(userId, variants, ip);
    } catch (error) {
      await this.deleteFiles(variantKeys(variants));
      throw error;
    }
    if (!result) {
      await this.deleteFiles(variantKeys(variants));
      throw notFound();
    }
    await this.deleteFiles(result.oldKeys);
    return { photoUrl: result.photoUrl };
  }

  /**
   * Fase 13: imagen de un auspiciador (logo, banner o producto). Solo ADMIN. Devuelve las URL
   * públicas; la imagen no queda registrada en `images` (no es contenido de una barbería).
   */
  async uploadSponsorAsset(file: Buffer | undefined): Promise<{ url: string; thumbUrl: string }> {
    const variants = await this.store(file, 'SPONSOR_ASSET');
    return {
      url: variantUrl(this.storage, variants, 'large')!,
      thumbUrl: variantUrl(this.storage, variants, 'thumb')!,
    };
  }

  /** Quita la foto de perfil (idempotente). */
  async deleteUserPhoto(userId: string, ip: string | null): Promise<{ photoUrl: null }> {
    const result = await this.users.replacePhoto(userId, null, ip);
    if (!result) throw notFound();
    await this.deleteFiles(result.oldKeys);
    return { photoUrl: null };
  }

  // ───────────── Carrera del barbero: foto del perfil y portafolio ─────────────

  /** Foto del perfil profesional (cuadrado de 512 px). `null` si la cuenta no tiene perfil. */
  async setProfilePhoto(
    userId: string,
    file: Buffer | undefined,
    ip: string | null,
  ): Promise<{ photoUrl: string | null }> {
    const profile = await this.requireOwnProfile(userId);
    const variants = await this.store(file, 'USER_PHOTO');
    let oldKeys: string[];
    try {
      oldKeys = await this.prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ photo_variants: unknown }[]>`
          SELECT photo_variants FROM barber_profiles WHERE id = ${profile.id}::uuid FOR UPDATE`;
        await tx.barberProfile.update({
          where: { id: profile.id },
          data: { photoVariants: variants },
        });
        await this.audit.record(
          {
            actorId: userId,
            action: 'barber_profile.photo_updated',
            entityType: 'barber_profile',
            entityId: profile.id,
            ip,
          },
          tx,
        );
        return variantKeys(row?.photo_variants);
      });
    } catch (error) {
      await this.deleteFiles(variantKeys(variants));
      throw error;
    }
    await this.deleteFiles(oldKeys);
    return { photoUrl: variantUrl(this.storage, variants, 'square') };
  }

  async deleteProfilePhoto(userId: string, ip: string | null): Promise<{ photoUrl: null }> {
    const profile = await this.requireOwnProfile(userId);
    const oldKeys = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ photo_variants: unknown }[]>`
        SELECT photo_variants FROM barber_profiles WHERE id = ${profile.id}::uuid FOR UPDATE`;
      await tx.barberProfile.update({
        where: { id: profile.id },
        data: { photoVariants: Prisma.DbNull },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'barber_profile.photo_removed',
          entityType: 'barber_profile',
          entityId: profile.id,
          ip,
        },
        tx,
      );
      return variantKeys(row?.photo_variants);
    });
    await this.deleteFiles(oldKeys);
    return { photoUrl: null };
  }

  /** El barbero sube un corte a su portafolio desde su perfil (sin barbería). */
  async uploadPortfolio(
    userId: string,
    file: Buffer | undefined,
    dto: { caption?: string; styleIds?: string[]; consent: boolean; faceShape?: FaceShape | null },
    ip: string | null,
  ): Promise<PortfolioItemDto> {
    const profile = await this.requireOwnProfile(userId);
    if (!dto.consent) throw invalidField('consent', 'isTrue');
    const styleIds = dto.styleIds ?? [];
    await this.assertStyles(styleIds);
    const max = await this.settings.positiveInt(
      SettingKey.IMAGES_GALLERY_MAX,
      IMAGE_DEFAULTS.galleryMaxPerBarber,
    );
    if ((await this.countPortfolio(this.prisma, profile.id)) >= max) throw galleryFull(max);
    const variants = await this.store(file, 'GALLERY');
    const now = new Date(this.clock.now());
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM barber_profiles WHERE id = ${profile.id}::uuid FOR UPDATE`;
        if ((await this.countPortfolio(tx, profile.id)) >= max) throw galleryFull(max);
        const image = await tx.image.create({
          data: {
            barbershopId: null,
            barberProfileId: profile.id,
            kind: 'GALLERY',
            variants,
            uploadedById: userId,
            consentGiven: true,
            consentByUserId: userId,
            consentTimestamp: now,
            caption: dto.caption ?? null,
            styles: { create: styleIds.map((styleId) => ({ styleId })) },
            faceShape: dto.faceShape ?? null,
            labelConfirmed: styleIds.length > 0,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorId: userId,
            action: 'image.uploaded',
            entityType: 'image',
            entityId: image.id,
            changes: { kind: 'PORTFOLIO', barberProfileId: profile.id, consent: true },
            ip,
          },
          tx,
        );
        return image.id;
      });
    } catch (error) {
      await this.deleteFiles(variantKeys(variants));
      throw error;
    }
    const row = await this.prisma.image.findUniqueOrThrow({
      where: { id },
      include: portfolioInclude,
    });
    return this.toPortfolio(row);
  }

  /** El barbero quita un corte de su portafolio (también los que subió en una barbería). */
  async deletePortfolio(userId: string, imageId: string, ip: string | null): Promise<void> {
    const profile = await this.requireOwnProfile(userId);
    const keys = await this.prisma.$transaction(async (tx) => {
      const image = await tx.image.findFirst({
        where: { id: imageId, barberProfileId: profile.id, kind: 'GALLERY', deletedAt: null },
        select: { variants: true },
      });
      if (!image) throw imageNotFound();
      await tx.image.update({
        where: { id: imageId },
        data: { deletedAt: new Date(this.clock.now()) },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'image.deleted',
          entityType: 'image',
          entityId: imageId,
          changes: { kind: 'PORTFOLIO' },
          ip,
        },
        tx,
      );
      return variantKeys(image.variants);
    });
    await this.deleteFiles(keys);
  }

  /** Portafolio público de un perfil: sus cortes en todas las barberías y los suyos propios. */
  async portfolio(
    profileId: string,
    query: { cursor?: string; limit?: number; style?: string },
  ): Promise<{ items: PortfolioItemDto[]; nextCursor: string | null }> {
    const threshold = await this.hideThreshold();
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.ImageWhereInput = {
      barberProfileId: profileId,
      kind: 'GALLERY',
      deletedAt: null,
      removedAt: null,
      ...(query.style ? { styles: { some: { style: { key: query.style, isActive: true } } } } : {}),
    };
    const items: PortfolioRow[] = [];
    let cursor = query.cursor;
    let more = false;
    for (;;) {
      const batch = await this.prisma.image.findMany({
        where: { ...where, ...(cursor ? { id: { lt: cursor } } : {}) },
        include: portfolioInclude,
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      items.push(...batch.filter((r) => !isHiddenByReports(r._count.reports, threshold)));
      if (items.length > limit) {
        more = true;
        break;
      }
      if (batch.length <= limit) break;
      cursor = batch[batch.length - 1]!.id;
    }
    const page = items.slice(0, limit);
    return {
      items: page.map((r) => this.toPortfolio(r)),
      nextCursor: more ? page[page.length - 1]!.id : null,
    };
  }

  private toPortfolio(row: PortfolioRow): PortfolioItemDto {
    const v = row.variants as StoredVariants;
    const large = v.large ?? v.thumb!;
    return {
      id: row.id,
      thumbUrl: this.storage.publicUrl((v.thumb ?? large).key),
      largeUrl: this.storage.publicUrl(large.key),
      width: large.width,
      height: large.height,
      caption: row.caption,
      styles: row.styles
        .map((s) => s.style)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(({ id, key, name }) => ({ id, key, name })),
      barbershopName: row.barbershop?.name ?? null,
      faceShape: row.faceShape,
      labelConfirmed: row.labelConfirmed,
      createdAt: row.createdAt,
    };
  }

  private countPortfolio(db: Prisma.TransactionClient, profileId: string): Promise<number> {
    return db.image.count({
      where: { barberProfileId: profileId, kind: 'GALLERY', deletedAt: null },
    });
  }

  private async requireOwnProfile(userId: string): Promise<{ id: string }> {
    const profile = await this.prisma.barberProfile.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    if (!profile) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Aún no tienes perfil profesional. Créalo en PUT /me/barber-profile.',
        HttpStatus.NOT_FOUND,
      );
    }
    return profile;
  }

  // ───────────── Fotos de demostración (solo desarrollo) ─────────────

  /**
   * Guarda una foto de demostración (stock con licencia libre) en la galería de una barbería. Pasa
   * por el mismo procesamiento que cualquier subida: se valida que sea una imagen real, se vuelve
   * a codificar a WebP y se eliminan sus metadatos. Queda marcada `isDemo` y nunca confirmada.
   */
  async createDemoImage(input: {
    file: Buffer;
    barbershopId: string;
    uploadedById: string;
    styleIds: string[];
    caption: string | null;
    source: Prisma.InputJsonObject;
  }): Promise<string> {
    const variants = await this.store(input.file, 'GALLERY');
    try {
      const image = await this.prisma.image.create({
        data: {
          barbershopId: input.barbershopId,
          kind: 'GALLERY',
          variants,
          uploadedById: input.uploadedById,
          // Foto de stock con licencia libre (ver demoSource): la registra quien carga la demo.
          consentGiven: true,
          consentByUserId: input.uploadedById,
          consentTimestamp: new Date(this.clock.now()),
          caption: input.caption,
          isDemo: true,
          labelConfirmed: false,
          demoSource: input.source,
          styles: { create: input.styleIds.map((styleId) => ({ styleId })) },
        },
        select: { id: true },
      });
      return image.id;
    } catch (error) {
      await this.deleteFiles(variantKeys(variants));
      throw error;
    }
  }

  /** Borra todas las fotos de demostración y sus archivos. Devuelve cuántas. */
  async deleteDemoImages(): Promise<number> {
    const rows = await this.prisma.image.findMany({
      where: { isDemo: true, deletedAt: null },
      select: { id: true, variants: true },
    });
    await this.prisma.image.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { deletedAt: new Date(this.clock.now()) },
    });
    await this.deleteFiles(rows.flatMap((r) => variantKeys(r.variants)));
    return rows.length;
  }

  // ───────────── Logo, portada y foto del barbero ─────────────

  async setBarbershopImage(
    userId: string,
    barbershopId: string,
    kind: 'BARBERSHOP_LOGO' | 'BARBERSHOP_COVER',
    file: Buffer | undefined,
    ip: string | null,
  ): Promise<BarbershopMedia> {
    await this.access.requireMember(userId, barbershopId);
    await this.replaceSingle({ userId, barbershopId, barberId: null, kind, file, ip });
    return this.media(barbershopId);
  }

  async deleteBarbershopImage(
    userId: string,
    barbershopId: string,
    kind: 'BARBERSHOP_LOGO' | 'BARBERSHOP_COVER',
    ip: string | null,
  ): Promise<BarbershopMedia> {
    await this.access.requireMember(userId, barbershopId);
    await this.removeSingle({ userId, barbershopId, barberId: null, kind, ip });
    return this.media(barbershopId);
  }

  async setBarberPhoto(
    userId: string,
    barbershopId: string,
    barberId: string,
    file: Buffer | undefined,
    ip: string | null,
  ): Promise<BarberPhotoDto> {
    await this.requireBarberEditor(userId, barbershopId, barberId);
    const variants = await this.replaceSingle({
      userId,
      barbershopId,
      barberId,
      kind: 'BARBER_PHOTO',
      file,
      ip,
    });
    return { photoUrl: variantUrl(this.storage, variants, 'square') };
  }

  async deleteBarberPhoto(
    userId: string,
    barbershopId: string,
    barberId: string,
    ip: string | null,
  ): Promise<BarberPhotoDto> {
    await this.requireBarberEditor(userId, barbershopId, barberId);
    await this.removeSingle({ userId, barbershopId, barberId, kind: 'BARBER_PHOTO', ip });
    return { photoUrl: null };
  }

  // ───────────── Galería ─────────────

  async uploadGallery(
    userId: string,
    barbershopId: string,
    barberId: string,
    file: Buffer | undefined,
    dto: GalleryUploadDto,
    ip: string | null,
  ): Promise<GalleryImageManageDto> {
    await this.requireBarberEditor(userId, barbershopId, barberId);
    const styleIds = dto.styleIds ?? [];
    await this.assertStyles(styleIds);
    if (dto.serviceId) await this.assertService(barbershopId, dto.serviceId);
    const max = await this.settings.positiveInt(
      SettingKey.IMAGES_GALLERY_MAX,
      IMAGE_DEFAULTS.galleryMaxPerBarber,
    );
    // Comprobación temprana (sin subir nada); la definitiva va en la transacción.
    if ((await this.countGallery(this.prisma, barberId)) >= max) throw galleryFull(max);

    const variants = await this.store(file, 'GALLERY');
    const now = new Date(this.clock.now());
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const [link] = await tx.$queryRaw<{ profile_id: string | null }[]>`
          SELECT barber_profile_id::text AS profile_id FROM barbers
           WHERE id = ${barberId}::uuid FOR UPDATE`;
        if ((await this.countGallery(tx, barberId)) >= max) throw galleryFull(max);
        const image = await tx.image.create({
          data: {
            barbershopId,
            barberId,
            // Carrera del barbero: el corte también va a su portafolio (se lo lleva si se va).
            barberProfileId: link?.profile_id ?? null,
            kind: 'GALLERY',
            variants: variants,
            uploadedById: userId,
            consentGiven: true,
            consentByUserId: userId,
            consentTimestamp: now,
            caption: dto.caption ?? null,
            serviceId: dto.serviceId ?? null,
            styles: { create: styleIds.map((styleId) => ({ styleId })) },
            // Forma de cara: quien sube es la barbería o el barbero (el experto): sus etiquetas
            // quedan confirmadas si eligió al menos un estilo.
            faceShape: dto.faceShape ?? null,
            labelConfirmed: styleIds.length > 0,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorId: userId,
            action: 'image.uploaded',
            entityType: 'image',
            entityId: image.id,
            changes: { kind: 'GALLERY', barbershopId, barberId, consent: true },
            ip,
          },
          tx,
        );
        return image.id;
      });
    } catch (error) {
      await this.deleteFiles(variantKeys(variants));
      throw error;
    }
    return this.manageView(id);
  }

  async updateGallery(
    userId: string,
    barbershopId: string,
    imageId: string,
    dto: UpdateGalleryImageDto,
    ip: string | null,
  ): Promise<GalleryImageManageDto> {
    const image = await this.findGallery(barbershopId, imageId);
    await this.requireBarberEditor(userId, barbershopId, image.barberId);
    if (dto.styleIds) await this.assertStyles(dto.styleIds);
    if (dto.serviceId) await this.assertService(barbershopId, dto.serviceId);
    const pinnedMax = await this.settings.positiveInt(
      SettingKey.IMAGES_PINNED_MAX,
      IMAGE_DEFAULTS.pinnedMaxPerBarber,
    );
    await this.prisma.$transaction(async (tx) => {
      if (dto.pinned === true && !image.pinnedAt) {
        await tx.$queryRaw`SELECT id FROM barbers WHERE id = ${image.barberId}::uuid FOR UPDATE`;
        const pinned = await tx.image.count({
          where: {
            barberId: image.barberId,
            kind: 'GALLERY',
            deletedAt: null,
            pinnedAt: { not: null },
          },
        });
        if (pinned >= pinnedMax) {
          throw new AppException(
            ErrorCode.IMAGE_LIMIT_REACHED,
            `Solo puedes destacar ${pinnedMax} fotos por barbero.`,
            HttpStatus.CONFLICT,
            [{ limit: pinnedMax }],
          );
        }
      }
      await tx.image.update({
        where: { id: imageId },
        data: {
          caption: dto.caption,
          serviceId: dto.serviceId,
          faceShape: dto.faceShape,
          pinnedAt:
            dto.pinned === undefined
              ? undefined
              : dto.pinned
                ? (image.pinnedAt ?? new Date(this.clock.now()))
                : null,
          ...(dto.styleIds
            ? {
                styles: {
                  deleteMany: {},
                  create: dto.styleIds.map((styleId) => ({ styleId })),
                },
              }
            : {}),
        },
      });
      // Editar los estilos o la forma es una confirmación del barbero (nunca en fotos de demo).
      if (dto.styleIds !== undefined || dto.faceShape !== undefined) {
        const styles = await tx.imageStyle.count({ where: { imageId } });
        await tx.image.updateMany({
          where: { id: imageId, isDemo: false },
          data: { labelConfirmed: styles > 0 },
        });
      }
      await this.audit.record(
        {
          actorId: userId,
          action: 'image.updated',
          entityType: 'image',
          entityId: imageId,
          changes: {
            fields: Object.keys(dto).filter((k) => dto[k as keyof typeof dto] !== undefined),
          },
          ip,
        },
        tx,
      );
    });
    return this.manageView(imageId);
  }

  async deleteGallery(
    userId: string,
    barbershopId: string,
    imageId: string,
    ip: string | null,
  ): Promise<void> {
    const image = await this.findGallery(barbershopId, imageId);
    await this.requireBarberEditor(userId, barbershopId, image.barberId);
    await this.prisma.$transaction(async (tx) => {
      await tx.image.update({
        where: { id: imageId },
        data: { deletedAt: new Date(this.clock.now()), pinnedAt: null },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'image.deleted',
          entityType: 'image',
          entityId: imageId,
          changes: { kind: 'GALLERY' },
          ip,
        },
        tx,
      );
    });
    await this.deleteFiles(variantKeys(image.variants));
  }

  /** Galería pública: sin fotos retiradas ni ocultas por reportes. Destacadas aparte. */
  async publicGallery(barbershopId: string, query: GalleryQueryDto): Promise<GalleryPageDto> {
    await this.access.requirePublic(barbershopId);
    const threshold = await this.hideThreshold();
    const where = await this.galleryWhere(barbershopId, query);
    const visible = (rows: GalleryRow[]) =>
      rows.filter((r) => !isHiddenByReports(r._count.reports, threshold));

    const pinned = query.cursor
      ? []
      : visible(
          await this.prisma.image.findMany({
            where: { ...where, pinnedAt: { not: null }, removedAt: null },
            include: galleryInclude,
            orderBy: [{ pinnedAt: 'desc' }, { id: 'desc' }],
          }),
        );
    const { rows, nextCursor } = await this.pageGallery(
      { ...where, pinnedAt: null, removedAt: null },
      query,
      visible,
    );
    return {
      pinned: pinned.map((r) => this.toPublic(r)),
      items: rows.map((r) => this.toPublic(r)),
      nextCursor,
    };
  }

  /** Galería de gestión (OWNER, MANAGER o el propio barbero): incluye las ocultas. */
  async manageGallery(
    userId: string,
    barbershopId: string,
    query: GalleryQueryDto,
  ): Promise<GalleryManagePageDto> {
    let barberId = query.barberId;
    if (!(await this.access.isMember(barbershopId, userId))) {
      // Sin ser OWNER ni MANAGER: solo el propio barbero, y solo su galería.
      const own = await this.prisma.barber.findFirst({
        where: { barbershopId, userId, deletedAt: null, barbershop: { deletedAt: null } },
        select: { id: true },
      });
      if (!own) throw notFound();
      if (barberId && barberId !== own.id) throw forbidden();
      barberId = own.id;
    }
    const threshold = await this.hideThreshold();
    const where = await this.galleryWhere(barbershopId, { ...query, barberId });
    const { rows, nextCursor } = await this.pageGallery(where, query, (r) => r);
    return { items: rows.map((r) => this.toManage(r, threshold)), nextCursor };
  }

  // ───────────── Estilos y especialidades ─────────────

  async listStyles(categoryKey?: string): Promise<ServiceStyleDto[]> {
    const styles = await this.prisma.serviceStyle.findMany({
      where: {
        isActive: true,
        category: { isActive: true, ...(categoryKey ? { key: categoryKey } : {}) },
      },
      include: { category: { select: { key: true, sortOrder: true } } },
    });
    return styles
      .sort(
        (a, b) =>
          a.category.sortOrder - b.category.sortOrder ||
          a.sortOrder - b.sortOrder ||
          a.key.localeCompare(b.key),
      )
      .map((s) => ({
        id: s.id,
        key: s.key,
        name: s.name,
        categoryId: s.categoryId,
        categoryKey: s.category.key,
        sortOrder: s.sortOrder,
        description: s.description,
        maintenance: s.maintenance,
        hairTypes: s.hairTypes,
        vibe: s.vibe,
      }));
  }

  async setSpecialties(
    userId: string,
    barbershopId: string,
    barberId: string,
    dto: SetSpecialtiesDto,
    ip: string | null,
  ): Promise<void> {
    await this.requireBarberEditor(userId, barbershopId, barberId);
    await this.assertStyles(dto.styleIds);
    await this.prisma.$transaction(async (tx) => {
      await tx.barberSpecialty.deleteMany({ where: { barberId } });
      if (dto.styleIds.length) {
        await tx.barberSpecialty.createMany({
          data: dto.styleIds.map((styleId) => ({ barberId, styleId })),
        });
      }
      await this.audit.record(
        {
          actorId: userId,
          action: 'barber.specialties_updated',
          entityType: 'barber',
          entityId: barberId,
          changes: { count: dto.styleIds.length },
          ip,
        },
        tx,
      );
    });
  }

  // ───────────── Reportes ─────────────

  /** Una vez por persona e imagen. Con N reportes abiertos la foto se oculta sola. */
  async report(userId: string, imageId: string, dto: CreateImageReportDto): Promise<void> {
    const image = await this.prisma.image.findFirst({
      where: { id: imageId, kind: 'GALLERY', deletedAt: null, removedAt: null },
      select: {
        barbershopId: true,
        barbershop: { select: { status: true, deletedAt: true } },
        barberProfile: { select: { userId: true } },
      },
    });
    if (!image || image.barbershop?.deletedAt) throw imageNotFound();
    // Nadie reporta sus propias fotos (la barbería, las de su local; el barbero, su portafolio).
    if (image.barberProfile?.userId === userId) throw forbidden();
    if (image.barbershopId && (await this.access.isMember(image.barbershopId, userId))) {
      throw forbidden();
    }
    try {
      await this.prisma.imageReport.create({
        data: { imageId, reportedById: userId, reason: dto.reason, details: dto.details ?? null },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppException(
          ErrorCode.ALREADY_REPORTED,
          'Ya reportaste esta imagen.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  // ───────────── Borrado de archivos (cuentas y barberías eliminadas) ─────────────

  /**
   * Marca como eliminadas las imágenes de una barbería (o de los barberos indicados) dentro de la
   * transacción recibida y devuelve sus claves: el llamador borra los archivos **después** de
   * confirmar, con `deleteFiles`.
   */
  async softDeleteInTx(
    tx: Prisma.TransactionClient,
    where: { barbershopId?: string; barberIds?: string[]; kinds?: ImageKind[] },
  ): Promise<string[]> {
    const filter: Prisma.ImageWhereInput = {
      deletedAt: null,
      ...(where.kinds ? { kind: { in: where.kinds } } : {}),
      ...(where.barbershopId ? { barbershopId: where.barbershopId } : {}),
      ...(where.barberIds ? { barberId: { in: where.barberIds } } : {}),
    };
    if (!where.barbershopId && !where.barberIds?.length) return [];
    const images = await tx.image.findMany({ where: filter, select: { variants: true } });
    await tx.image.updateMany({
      where: filter,
      data: { deletedAt: new Date(this.clock.now()), pinnedAt: null },
    });
    return images.flatMap((i) => variantKeys(i.variants));
  }

  /** Borrado de archivos tolerante a fallos: un error se registra y no interrumpe. */
  async deleteFiles(keys: string[]): Promise<void> {
    if (keys.length === 0 || !this.storage.enabled) return;
    try {
      for (let i = 0; i < keys.length; i += 1000) {
        await this.storage.delete(keys.slice(i, i + 1000));
      }
    } catch (error) {
      this.logger.error(
        { err: (error as Error).name, count: keys.length },
        'No se pudieron borrar archivos de imágenes',
      );
    }
  }

  // ───────────── Internos ─────────────

  /** OWNER o MANAGER de la barbería (miembros), o el propio barbero (su cuenta vinculada). */
  private async requireBarberEditor(
    userId: string,
    barbershopId: string,
    barberId: string | null,
  ): Promise<void> {
    const isMember = await this.access.isMember(barbershopId, userId);
    const barber = barberId
      ? await this.prisma.barber.findFirst({
          where: { id: barberId, barbershopId, deletedAt: null, barbershop: { deletedAt: null } },
          select: { userId: true },
        })
      : null;
    if (isMember) {
      if (!barber) throw barberNotFound();
      return;
    }
    // No miembro: solo el propio barbero; a cualquier otro no se le revela la barbería.
    if (!barber || barber.userId !== userId) throw notFound();
  }

  private async replaceSingle(input: {
    userId: string;
    barbershopId: string;
    barberId: string | null;
    kind: SingleKind;
    file: Buffer | undefined;
    ip: string | null;
  }): Promise<StoredVariants> {
    const { userId, barbershopId, barberId, kind, ip } = input;
    const variants = await this.store(input.file, kind);
    let oldKeys: string[];
    try {
      oldKeys = await this.prisma.$transaction(async (tx) => {
        // Bloquea al dueño para que dos subidas simultáneas no choqen con el índice único.
        if (barberId) {
          await tx.$queryRaw`SELECT id FROM barbers WHERE id = ${barberId}::uuid FOR UPDATE`;
        } else {
          await tx.$queryRaw`SELECT id FROM barbershops WHERE id = ${barbershopId}::uuid FOR UPDATE`;
        }
        const keys = await this.retireCurrent(tx, barbershopId, barberId, kind);
        const image = await tx.image.create({
          data: {
            barbershopId,
            barberId,
            kind,
            variants: variants,
            uploadedById: userId,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorId: userId,
            action: 'image.uploaded',
            entityType: 'image',
            entityId: image.id,
            changes: {
              kind,
              barbershopId,
              ...(barberId ? { barberId } : {}),
              replaced: keys.length > 0,
            },
            ip,
          },
          tx,
        );
        return keys;
      });
    } catch (error) {
      await this.deleteFiles(variantKeys(variants));
      throw error;
    }
    await this.deleteFiles(oldKeys);
    return variants;
  }

  private async removeSingle(input: {
    userId: string;
    barbershopId: string;
    barberId: string | null;
    kind: SingleKind;
    ip: string | null;
  }): Promise<void> {
    const { userId, barbershopId, barberId, kind, ip } = input;
    const keys = await this.prisma.$transaction(async (tx) => {
      const removed = await this.retireCurrent(tx, barbershopId, barberId, kind);
      if (removed.length) {
        await this.audit.record(
          {
            actorId: userId,
            action: 'image.deleted',
            entityType: barberId ? 'barber' : 'barbershop',
            entityId: barberId ?? barbershopId,
            changes: { kind },
            ip,
          },
          tx,
        );
      }
      return removed;
    });
    await this.deleteFiles(keys);
  }

  private async retireCurrent(
    tx: Prisma.TransactionClient,
    barbershopId: string,
    barberId: string | null,
    kind: SingleKind,
  ): Promise<string[]> {
    const where: Prisma.ImageWhereInput = barberId
      ? { barberId, kind, deletedAt: null }
      : { barbershopId, kind, deletedAt: null };
    const current = await tx.image.findMany({ where, select: { id: true, variants: true } });
    if (current.length === 0) return [];
    await tx.image.updateMany({
      where: { id: { in: current.map((c) => c.id) } },
      data: { deletedAt: new Date(this.clock.now()) },
    });
    return current.flatMap((c) => variantKeys(c.variants));
  }

  /** Procesa y sube las variantes; devuelve lo que se guarda en `images.variants`. */
  private async store(file: Buffer | undefined, kind: ProcessedKind): Promise<StoredVariants> {
    if (!this.storage.enabled) throw storageUnavailable();
    if (!file) throw invalidField('file', 'isNotEmpty');
    const processed = await processImage(file, kind);
    const prefix = newKeyPrefix();
    const stored: StoredVariants = {};
    try {
      for (const v of processed) {
        const key = `${prefix}/${v.name}.webp`;
        await this.storage.put(key, v.buffer, 'image/webp');
        stored[v.name] = { key, width: v.width, height: v.height };
      }
    } catch (error) {
      await this.deleteFiles(variantKeys(stored));
      this.logger.error({ err: (error as Error).name }, 'Fallo al subir una imagen');
      throw storageUnavailable();
    }
    return stored;
  }

  private async media(barbershopId: string): Promise<BarbershopMedia> {
    return (
      (await barbershopMedia(this.prisma, this.storage, [barbershopId])).get(barbershopId) ??
      NO_MEDIA
    );
  }

  private countGallery(db: Prisma.TransactionClient, barberId: string): Promise<number> {
    return db.image.count({ where: { barberId, kind: 'GALLERY', deletedAt: null } });
  }

  private async assertStyles(styleIds: string[]): Promise<void> {
    if (styleIds.length === 0) return;
    const found = await this.prisma.serviceStyle.count({
      where: { id: { in: styleIds }, isActive: true },
    });
    if (found !== styleIds.length) throw invalidField('styleIds', 'activeStyle');
  }

  private async assertService(barbershopId: string, serviceId: string): Promise<void> {
    const found = await this.prisma.service.count({
      where: { id: serviceId, barbershopId, deletedAt: null },
    });
    if (!found) throw invalidField('serviceId', 'serviceOfBarbershop');
  }

  private async findGallery(
    barbershopId: string,
    imageId: string,
  ): Promise<{ barberId: string | null; pinnedAt: Date | null; variants: Prisma.JsonValue }> {
    const image = await this.prisma.image.findFirst({
      where: { id: imageId, barbershopId, kind: 'GALLERY', deletedAt: null },
      select: { barberId: true, pinnedAt: true, variants: true },
    });
    if (!image) {
      // Un no miembro no distingue "no existe" de "no es tuya".
      throw notFound();
    }
    return image;
  }

  private async hideThreshold(): Promise<number> {
    return this.settings.positiveInt(
      SettingKey.IMAGES_REPORT_HIDE_THRESHOLD,
      IMAGE_DEFAULTS.reportHideThreshold,
    );
  }

  private async galleryWhere(
    barbershopId: string,
    query: Pick<GalleryQueryDto, 'barberId' | 'style'>,
  ): Promise<Prisma.ImageWhereInput> {
    if (query.style) {
      const style = await this.prisma.serviceStyle.findFirst({
        where: { key: query.style, isActive: true },
        select: { id: true },
      });
      if (!style) throw invalidField('style', 'activeStyle');
    }
    return {
      barbershopId,
      kind: 'GALLERY',
      deletedAt: null,
      // Carrera del barbero: los cortes de un barbero que dejó la barbería son suyos (portafolio).
      OR: [{ barberProfileId: null }, { barber: { endedAt: null, deletedAt: null } }],
      ...(query.barberId ? { barberId: query.barberId } : {}),
      ...(query.style ? { styles: { some: { style: { key: query.style, isActive: true } } } } : {}),
    };
  }

  /**
   * Página por id descendente (las más recientes primero). `keep` descarta filas (ocultas): se
   * piden lotes hasta llenar la página o agotar las filas.
   */
  private async pageGallery(
    where: Prisma.ImageWhereInput,
    query: GalleryQueryDto,
    keep: (rows: GalleryRow[]) => GalleryRow[],
  ): Promise<{ rows: GalleryRow[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows: GalleryRow[] = [];
    let cursor = query.cursor;
    for (;;) {
      const batch = await this.prisma.image.findMany({
        where: { ...where, ...(cursor ? { id: { lt: cursor } } : {}) },
        include: galleryInclude,
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      rows.push(...keep(batch));
      if (rows.length > limit || batch.length <= limit) break;
      cursor = batch[batch.length - 1]!.id;
    }
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return { rows: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
  }

  private async manageView(imageId: string): Promise<GalleryImageManageDto> {
    const row = await this.prisma.image.findUniqueOrThrow({
      where: { id: imageId },
      include: galleryInclude,
    });
    return this.toManage(row, await this.hideThreshold());
  }

  toPublic(row: GalleryRow): GalleryImageDto {
    const v = row.variants as StoredVariants;
    const large = v.large ?? v.thumb!;
    const service =
      row.service && row.service.isAvailable && !row.service.deletedAt
        ? {
            id: row.service.id,
            name: row.service.name,
            price: {
              amount: row.service.priceAmount,
              currency: row.service.currency || SERVICE_CURRENCY,
            },
            durationMinutes: row.service.durationMinutes,
          }
        : null;
    return {
      id: row.id,
      // Las galerías de barbería siempre filtran por barbería: aquí nunca es null.
      barbershopId: row.barbershopId!,
      barberId: row.barberId,
      barberName: row.barber?.displayName ?? null,
      thumbUrl: this.storage.publicUrl((v.thumb ?? large).key),
      largeUrl: this.storage.publicUrl(large.key),
      width: large.width,
      height: large.height,
      caption: row.caption,
      styles: row.styles
        .map((s) => s.style)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(({ id, key, name }) => ({ id, key, name })),
      service,
      pinned: row.pinnedAt !== null,
      faceShape: row.faceShape,
      labelConfirmed: row.labelConfirmed,
      isDemo: row.isDemo,
      createdAt: row.createdAt,
    };
  }

  toManage(row: GalleryRow, threshold: number): GalleryImageManageDto {
    const openReports = row._count.reports;
    return {
      ...this.toPublic(row),
      openReports,
      removed: row.removedAt !== null,
      hidden: row.removedAt !== null || isHiddenByReports(openReports, threshold),
    };
  }
}

const galleryFull = (max: number): AppException =>
  new AppException(
    ErrorCode.IMAGE_LIMIT_REACHED,
    `La galería de este barbero ya tiene ${max} fotos. Borra alguna para subir otra.`,
    HttpStatus.CONFLICT,
    [{ limit: max }],
  );

export { galleryInclude, type GalleryRow };
