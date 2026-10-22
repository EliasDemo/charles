import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { variantUrl } from '../images/image-variants';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { ServicesService } from '../services/services.service';
import type {
  CatalogItemDto,
  CatalogSourceDto,
  ImportCatalogItemDto,
  UpdateCatalogItemDto,
} from './dto/shop.dto';

const invalid = (field: string, constraint: string) =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: [constraint] }],
  );

/**
 * Catálogo de cortes de la barbería: sus servicios con estilo y foto de portada. La barbería los
 * crea o los **toma del portafolio de sus barberos** (fotos de sus cortes, con estilo).
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly services: ServicesService,
    private readonly audit: AuditService,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
  ) {}

  async list(userId: string, barbershopId: string): Promise<CatalogItemDto[]> {
    await this.access.requireMember(userId, barbershopId);
    const rows = await this.prisma.service.findMany({
      where: { barbershopId, deletedAt: null },
      include: {
        style: { select: { key: true, name: true } },
        coverImage: {
          select: {
            variants: true,
            barber: { select: { displayName: true } },
            barberProfile: { select: { displayName: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      priceAmount: s.priceAmount,
      durationMinutes: s.durationMinutes,
      isAvailable: s.isAvailable,
      styleKey: s.style?.key ?? null,
      styleName: s.style?.name ?? null,
      coverUrl: s.coverImage ? variantUrl(this.storage, s.coverImage.variants, 'large') : null,
      fromBarberName:
        s.coverImage?.barberProfile?.displayName ?? s.coverImage?.barber?.displayName ?? null,
    }));
  }

  /** Fotos de cortes de los barberos de la barbería (su galería aquí y su portafolio propio). */
  async sources(userId: string, barbershopId: string): Promise<CatalogSourceDto[]> {
    await this.access.requireMember(userId, barbershopId);
    const barbers = await this.prisma.barber.findMany({
      where: { barbershopId, deletedAt: null, endedAt: null },
      select: { id: true, barberProfileId: true },
    });
    const profileIds = barbers.map((b) => b.barberProfileId).filter((id): id is string => !!id);
    const rows = await this.prisma.image.findMany({
      where: {
        kind: 'GALLERY',
        deletedAt: null,
        removedAt: null,
        OR: [
          { barberId: { in: barbers.map((b) => b.id) } },
          ...(profileIds.length ? [{ barberProfileId: { in: profileIds } }] : []),
        ],
      },
      include: {
        styles: { select: { style: { select: { key: true } } } },
        barber: { select: { displayName: true } },
        barberProfile: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({
      imageId: r.id,
      imageUrl: variantUrl(this.storage, r.variants, 'large') ?? '',
      barberName: r.barberProfile?.displayName ?? r.barber?.displayName ?? '',
      caption: r.caption,
      styleKeys: r.styles.map((s) => s.style.key),
    }));
  }

  async update(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    serviceId: string,
    dto: UpdateCatalogItemDto,
  ): Promise<CatalogItemDto[]> {
    await this.access.requireMember(actor.userId, barbershopId);
    const service = await this.prisma.service.count({
      where: { id: serviceId, barbershopId, deletedAt: null },
    });
    if (!service)
      throw new AppException(ErrorCode.NOT_FOUND, 'El servicio no existe.', HttpStatus.NOT_FOUND);
    const styleId =
      dto.styleKey === undefined
        ? undefined
        : dto.styleKey === null
          ? null
          : await this.styleId(dto.styleKey);
    if (dto.coverImageId) await this.assertSource(barbershopId, dto.coverImageId);
    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id: serviceId },
        data: { styleId, coverImageId: dto.coverImageId },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'catalog.updated',
          entityType: 'service',
          entityId: serviceId,
          changes: { styleKey: dto.styleKey, coverImageId: dto.coverImageId },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    return this.list(actor.userId, barbershopId);
  }

  /** Crea un servicio a partir de una foto del portafolio de un barbero de la barbería. */
  async importFromBarber(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    dto: ImportCatalogItemDto,
  ): Promise<CatalogItemDto[]> {
    await this.access.requireMember(actor.userId, barbershopId);
    const image = await this.assertSource(barbershopId, dto.imageId);
    const style = image.styles[0]?.style;
    if (!style) throw invalid('imageId', 'imageWithStyle');
    const created = await this.services.create(
      actor.userId,
      barbershopId,
      {
        name: dto.name ?? style.name,
        priceAmount: dto.priceAmount,
        durationMinutes: dto.durationMinutes,
        categoryKey: style.category.key,
      },
      actor.ip ?? null,
    );
    await this.prisma.service.update({
      where: { id: created.id },
      data: { styleId: style.id, coverImageId: image.id },
    });
    // El barbero autor de la foto queda asignado al servicio.
    const author = image.barberId
      ? image.barberId
      : (
          await this.prisma.barber.findFirst({
            where: {
              barbershopId,
              barberProfileId: image.barberProfileId,
              deletedAt: null,
              endedAt: null,
            },
            select: { id: true },
          })
        )?.id;
    if (author) {
      await this.prisma.barberService.createMany({
        data: [{ barberId: author, serviceId: created.id }],
        skipDuplicates: true,
      });
    }
    return this.list(actor.userId, barbershopId);
  }

  private async styleId(key: string): Promise<string> {
    const style = await this.prisma.serviceStyle.findFirst({
      where: { key, isActive: true },
      select: { id: true },
    });
    if (!style) throw invalid('styleKey', 'activeStyle');
    return style.id;
  }

  private async assertSource(barbershopId: string, imageId: string) {
    const barbers = await this.prisma.barber.findMany({
      where: { barbershopId, deletedAt: null },
      select: { id: true, barberProfileId: true },
    });
    const profileIds = barbers.map((b) => b.barberProfileId).filter((id): id is string => !!id);
    const image = await this.prisma.image.findFirst({
      where: {
        id: imageId,
        kind: 'GALLERY',
        deletedAt: null,
        removedAt: null,
        OR: [
          { barberId: { in: barbers.map((b) => b.id) } },
          ...(profileIds.length ? [{ barberProfileId: { in: profileIds } }] : []),
        ],
      },
      include: {
        styles: {
          include: {
            style: { select: { id: true, name: true, category: { select: { key: true } } } },
          },
        },
      },
    });
    if (!image) throw invalid('imageId', 'photoOfYourBarbers');
    return image;
  }
}
