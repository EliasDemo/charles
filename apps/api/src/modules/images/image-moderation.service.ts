import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { DEFAULT_PAGE_SIZE } from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { StaffActor } from '../admin/admin-access';
import { SettingKey, SettingsService } from '../settings/settings.service';
import type {
  AdminReportedImageDto,
  AdminReportedImagePageDto,
  AdminServiceStyleDto,
  CreateStyleDto,
  ImageModerationDecision,
  ReportedImagesQueryDto,
  UpdateStyleDto,
} from './dto/image.dto';
import { IMAGE_DEFAULTS } from './image-policy';
import { galleryInclude, ImagesService } from './images.service';

const imageNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La imagen no existe.', HttpStatus.NOT_FOUND);

/** Moderación de fotos reportadas y catálogo de estilos (soporte y ADMIN, Fase 14). */
@Injectable()
export class ImageModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImagesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Fotos con reportes en ese estado (por defecto, abiertos), las más recientes primero. */
  async reported(query: ReportedImagesQueryDto): Promise<AdminReportedImagePageDto> {
    const status = query.status ?? 'OPEN';
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await this.prisma.image.findMany({
      where: {
        kind: 'GALLERY',
        deletedAt: null,
        reports: { some: { status } },
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      include: {
        ...galleryInclude,
        reports: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, reason: true, details: true, status: true, createdAt: true },
        },
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const threshold = await this.threshold();
    const page = rows.slice(0, limit);
    return {
      items: page.map((row): AdminReportedImageDto => ({
        ...this.images.toManage(row, threshold),
        reports: row.reports,
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * KEEP: se mantiene y se cierran los reportes abiertos. REMOVE: se retira (deja de mostrarse) y
   * se cierran. RESTORE: una foto retirada vuelve a mostrarse.
   */
  async moderate(
    staff: StaffActor,
    imageId: string,
    decision: ImageModerationDecision,
    reason: string,
  ): Promise<AdminReportedImageDto> {
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      const [image] = await tx.$queryRaw<{ removed_at: Date | null }[]>`
        SELECT removed_at FROM images
         WHERE id = ${imageId}::uuid AND kind = 'GALLERY' AND deleted_at IS NULL FOR UPDATE`;
      if (!image) throw imageNotFound();
      if (decision === 'RESTORE' && !image.removed_at) {
        throw new AppException(
          ErrorCode.STATUS_CHANGE_NOT_ALLOWED,
          'La foto no está retirada.',
          HttpStatus.CONFLICT,
        );
      }
      if (decision === 'REMOVE' && image.removed_at) {
        throw new AppException(
          ErrorCode.STATUS_CHANGE_NOT_ALLOWED,
          'La foto ya está retirada.',
          HttpStatus.CONFLICT,
        );
      }
      if (decision !== 'KEEP') {
        await tx.image.update({
          where: { id: imageId },
          data: decision === 'REMOVE' ? { removedAt: now, pinnedAt: null } : { removedAt: null },
        });
      }
      const resolved = await tx.imageReport.updateMany({
        where: { imageId, status: { not: 'RESOLVED' } },
        data: {
          status: 'RESOLVED',
          resolution: `${decision}: ${reason}`,
          resolvedById: staff.id,
          resolvedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: staff.id,
          action: `image.moderation.${decision.toLowerCase()}`,
          entityType: 'image',
          entityId: imageId,
          changes: { decision, reportsResolved: resolved.count, actorRole: staff.role },
        },
        tx,
      );
    });
    const row = await this.prisma.image.findUniqueOrThrow({
      where: { id: imageId },
      include: {
        ...galleryInclude,
        reports: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, reason: true, details: true, status: true, createdAt: true },
        },
      },
    });
    return { ...this.images.toManage(row, await this.threshold()), reports: row.reports };
  }

  // ───────────── Estilos (solo ADMIN) ─────────────

  async listStyles(): Promise<AdminServiceStyleDto[]> {
    const styles = await this.prisma.serviceStyle.findMany({
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
        isActive: s.isActive,
      }));
  }

  async createStyle(staff: StaffActor, dto: CreateStyleDto): Promise<AdminServiceStyleDto> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: dto.categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'categoryId', constraints: ['exists'] }],
      );
    }
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const style = await tx.serviceStyle.create({
          data: {
            key: dto.key,
            name: dto.name,
            categoryId: dto.categoryId,
            sortOrder: dto.sortOrder ?? 0,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorId: staff.id,
            action: 'service_style.created',
            entityType: 'service_style',
            entityId: style.id,
            changes: { key: dto.key, name: dto.name, actorRole: staff.role },
          },
          tx,
        );
        return style.id;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Ya existe un estilo con esa clave.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
    return (await this.listStyles()).find((s) => s.id === id)!;
  }

  async updateStyle(
    staff: StaffActor,
    id: string,
    dto: UpdateStyleDto,
  ): Promise<AdminServiceStyleDto> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.serviceStyle.findUnique({ where: { id } });
      if (!before) {
        throw new AppException(ErrorCode.NOT_FOUND, 'El estilo no existe.', HttpStatus.NOT_FOUND);
      }
      const after = await tx.serviceStyle.update({
        where: { id },
        data: { name: dto.name, sortOrder: dto.sortOrder, isActive: dto.isActive },
      });
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'service_style.updated',
          entityType: 'service_style',
          entityId: id,
          changes: {
            from: { name: before.name, sortOrder: before.sortOrder, isActive: before.isActive },
            to: { name: after.name, sortOrder: after.sortOrder, isActive: after.isActive },
            actorRole: staff.role,
          },
        },
        tx,
      );
    });
    return (await this.listStyles()).find((s) => s.id === id)!;
  }

  private threshold(): Promise<number> {
    return this.settings.positiveInt(
      SettingKey.IMAGES_REPORT_HIDE_THRESHOLD,
      IMAGE_DEFAULTS.reportHideThreshold,
    );
  }
}
