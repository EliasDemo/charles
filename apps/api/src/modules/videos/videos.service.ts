import { randomBytes } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { IMAGE_DEFAULTS, isHiddenByReports } from '../images/image-policy';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { SettingKey, SettingsService } from '../settings/settings.service';
import type {
  ReportedVideoDto,
  VideoDto,
  VideoModerationDto,
  VideoReportDto,
} from './dto/video.dto';
import { processVideo, VIDEO_LIMITS, VideoRejected } from './video-processing';

export const VIDEOS_QUEUE = 'videos';
export interface VideoJob {
  videoId: string;
}

/** Videos activos por dueño (no borrados ni retirados). */
export const VIDEO_MAX = { barbershop: 5, barberProfile: 10 } as const;

interface VideoKeys {
  original?: string;
  video?: string;
  poster?: string;
}

type VideoRow = Prisma.VideoGetPayload<{ include: { _count: { select: { reports: true } } } }>;

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El video no existe.', HttpStatus.NOT_FOUND);

const storageUnavailable = (): AppException =>
  new AppException(
    ErrorCode.STORAGE_UNAVAILABLE,
    'No pudimos guardar el video. Inténtalo más tarde.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );

/**
 * Videos de 30 s (Carrera del barbero): publicidad del local (barbería) y cortes del barbero
 * (perfil). La subida guarda el original y responde enseguida (PROCESSING); un trabajo en segundo
 * plano valida la duración real, comprime a 720p sin metadatos y genera la miniatura. El original
 * se borra al terminar. Moderación por reportes, como las fotos.
 */
@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(VIDEOS_QUEUE) private readonly queue: Queue<VideoJob>,
  ) {}

  // ───────────── Subir ─────────────

  async uploadForBarbershop(
    userId: string,
    barbershopId: string,
    file: Buffer | undefined,
    caption: string | undefined,
  ): Promise<VideoDto> {
    await this.access.requireMember(userId, barbershopId);
    return this.upload(userId, { barbershopId }, file, caption);
  }

  async uploadForProfile(
    userId: string,
    file: Buffer | undefined,
    caption: string | undefined,
  ): Promise<VideoDto> {
    const profile = await this.ownProfile(userId);
    return this.upload(userId, { barberProfileId: profile.id }, file, caption);
  }

  private async upload(
    userId: string,
    owner: { barbershopId?: string; barberProfileId?: string },
    file: Buffer | undefined,
    caption: string | undefined,
  ): Promise<VideoDto> {
    if (!this.storage.enabled) throw storageUnavailable();
    if (!file || file.length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'file', constraints: ['isNotEmpty'] }],
      );
    }
    if (file.length > VIDEO_LIMITS.maxBytes) {
      throw new AppException(
        ErrorCode.PAYLOAD_TOO_LARGE,
        'El video supera los 50 MB.',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const max = owner.barbershopId ? VIDEO_MAX.barbershop : VIDEO_MAX.barberProfile;
    if ((await this.countActive(this.prisma, owner)) >= max) throw limitReached(max);

    const key = `vid/${randomBytes(16).toString('base64url')}`;
    const original = `${key}/original`;
    try {
      await this.storage.put(original, file, 'application/octet-stream');
    } catch {
      throw storageUnavailable();
    }
    let video: VideoRow;
    try {
      video = await this.prisma.$transaction(async (tx) => {
        // Bloquea al dueño para que dos subidas a la vez no pasen el tope.
        if (owner.barbershopId) {
          await tx.$queryRaw`SELECT id FROM barbershops WHERE id = ${owner.barbershopId}::uuid FOR UPDATE`;
        } else {
          await tx.$queryRaw`SELECT id FROM barber_profiles WHERE id = ${owner.barberProfileId}::uuid FOR UPDATE`;
        }
        if ((await this.countActive(tx, owner)) >= max) throw limitReached(max);
        const created = await tx.video.create({
          data: {
            barbershopId: owner.barbershopId ?? null,
            barberProfileId: owner.barberProfileId ?? null,
            uploadedById: userId,
            caption: caption ?? null,
            variants: { original },
          },
          include: { _count: { select: { reports: true } } },
        });
        await this.audit.record(
          {
            actorId: userId,
            action: 'video.uploaded',
            entityType: 'video',
            entityId: created.id,
            changes: { ...owner },
          },
          tx,
        );
        return created;
      });
    } catch (error) {
      await this.deleteFiles([original]);
      throw error;
    }
    await this.queue.add(
      'process',
      { videoId: video.id },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    return this.toDto(video, true);
  }

  /** Procesa un video (lo llama el trabajo de la cola). Idempotente: si ya no está PROCESSING, nada. */
  async process(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (!video || video.status !== 'PROCESSING') return;
    const keys = (video.variants ?? {}) as VideoKeys;
    const base = keys.original?.replace(/\/original$/, '');
    const source = keys.original ? await this.storage.get(keys.original) : null;
    if (!source || !base) {
      await this.fail(videoId, 'PROCESSING_FAILED', keys);
      return;
    }
    let result: Awaited<ReturnType<typeof processVideo>>;
    try {
      result = await processVideo(source.body);
    } catch (error) {
      const reason = error instanceof VideoRejected ? error.reason : 'PROCESSING_FAILED';
      if (!(error instanceof VideoRejected)) {
        this.logger.error({ err: (error as Error).name, videoId }, 'Fallo al procesar un video');
      }
      await this.fail(videoId, reason, keys);
      return;
    }
    // Cada intento escribe en su propia carpeta: si dos procesan el mismo video a la vez, el que
    // pierde borra solo lo suyo, nunca lo del que ganó.
    const out = `vid/${randomBytes(16).toString('base64url')}`;
    const done: VideoKeys = { video: `${out}/video.mp4`, poster: `${out}/poster.webp` };
    try {
      await this.storage.put(done.video!, result.video, 'video/mp4');
      await this.storage.put(done.poster!, result.poster, 'image/webp');
    } catch {
      await this.deleteFiles([done.video!, done.poster!]);
      throw new Error('Almacenamiento no disponible al guardar el video procesado');
    }
    const { count } = await this.prisma.video.updateMany({
      where: { id: videoId, status: 'PROCESSING' },
      data: { status: 'READY', variants: { ...done }, durationMs: result.durationMs },
    });
    // Si se borró mientras se procesaba, se descarta lo generado.
    await this.deleteFiles(
      count === 0 ? [done.video!, done.poster!, keys.original!] : [keys.original!],
    );
  }

  private async fail(videoId: string, reason: string, keys: VideoKeys): Promise<void> {
    await this.prisma.video.updateMany({
      where: { id: videoId, status: 'PROCESSING' },
      data: { status: 'FAILED', failureReason: reason, variants: {} },
    });
    await this.deleteFiles(keys.original ? [keys.original] : []);
  }

  // ───────────── Listas ─────────────

  async publicForBarbershop(barbershopId: string): Promise<VideoDto[]> {
    await this.access.requirePublic(barbershopId);
    return this.publicList({ barbershopId });
  }

  async publicForProfile(profileId: string): Promise<VideoDto[]> {
    const found = await this.prisma.barberProfile.count({
      where: { id: profileId, deletedAt: null },
    });
    if (!found)
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'El perfil del barbero no existe.',
        HttpStatus.NOT_FOUND,
      );
    return this.publicList({ barberProfileId: profileId });
  }

  async manageForBarbershop(userId: string, barbershopId: string): Promise<VideoDto[]> {
    await this.access.requireMember(userId, barbershopId);
    return this.manageList({ barbershopId });
  }

  async manageForProfile(userId: string): Promise<VideoDto[]> {
    const profile = await this.ownProfile(userId);
    return this.manageList({ barberProfileId: profile.id });
  }

  async remove(userId: string, videoId: string): Promise<void> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, deletedAt: null },
      select: { barbershopId: true, barberProfile: { select: { userId: true } }, variants: true },
    });
    if (!video) throw notFound();
    const allowed = video.barbershopId
      ? await this.access.isMember(video.barbershopId, userId)
      : video.barberProfile?.userId === userId;
    if (!allowed) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      await tx.video.update({
        where: { id: videoId },
        data: { deletedAt: new Date(this.clock.now()) },
      });
      await this.audit.record(
        { actorId: userId, action: 'video.deleted', entityType: 'video', entityId: videoId },
        tx,
      );
    });
    const keys = (video.variants ?? {}) as VideoKeys;
    await this.deleteFiles(
      [keys.original, keys.video, keys.poster].filter((k): k is string => !!k),
    );
  }

  // ───────────── Reportes y moderación ─────────────

  async report(userId: string, videoId: string, dto: VideoReportDto): Promise<void> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, status: 'READY', deletedAt: null, removedAt: null },
      select: { barbershopId: true, barberProfile: { select: { userId: true } } },
    });
    if (!video) throw notFound();
    const own = video.barbershopId
      ? await this.access.isMember(video.barbershopId, userId)
      : video.barberProfile?.userId === userId;
    if (own)
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'No puedes reportar tu propio video.',
        HttpStatus.FORBIDDEN,
      );
    try {
      await this.prisma.videoReport.create({
        data: { videoId, reporterId: userId, reason: dto.reason, details: dto.details ?? null },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.ALREADY_REPORTED,
          'Ya reportaste este video.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async reported(): Promise<ReportedVideoDto[]> {
    const rows = await this.prisma.video.findMany({
      where: { deletedAt: null, reports: { some: { resolvedAt: null } } },
      include: {
        _count: { select: { reports: { where: { resolvedAt: null } } } },
        reports: { where: { resolvedAt: null }, select: { reason: true } },
        barbershop: { select: { name: true } },
        barberProfile: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      ...this.toDto(r, false),
      ownerName: r.barbershop?.name ?? r.barberProfile?.displayName ?? null,
      openReports: r._count.reports,
      removed: r.removedAt !== null,
      reasons: [...new Set(r.reports.map((x) => x.reason))],
    }));
  }

  async moderate(staffId: string, videoId: string, dto: VideoModerationDto): Promise<void> {
    const video = await this.prisma.video.findFirst({ where: { id: videoId, deletedAt: null } });
    if (!video) throw notFound();
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      if (dto.decision === 'REMOVE')
        await tx.video.update({ where: { id: videoId }, data: { removedAt: now } });
      if (dto.decision === 'RESTORE')
        await tx.video.update({ where: { id: videoId }, data: { removedAt: null } });
      await tx.videoReport.updateMany({
        where: { videoId, resolvedAt: null },
        data: { resolvedAt: now },
      });
      await this.audit.record(
        {
          actorId: staffId,
          action: `video.moderation_${dto.decision.toLowerCase()}`,
          entityType: 'video',
          entityId: videoId,
          changes: { reason: dto.reason },
        },
        tx,
      );
    });
  }

  // ───────────── Internos ─────────────

  private async publicList(owner: {
    barbershopId?: string;
    barberProfileId?: string;
  }): Promise<VideoDto[]> {
    const threshold = await this.settings.positiveInt(
      SettingKey.IMAGES_REPORT_HIDE_THRESHOLD,
      IMAGE_DEFAULTS.reportHideThreshold,
    );
    const rows = await this.prisma.video.findMany({
      where: { ...owner, status: 'READY', deletedAt: null, removedAt: null },
      include: { _count: { select: { reports: { where: { resolvedAt: null } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows
      .filter((r) => !isHiddenByReports(r._count.reports, threshold))
      .map((r) => this.toDto(r, false));
  }

  private async manageList(owner: {
    barbershopId?: string;
    barberProfileId?: string;
  }): Promise<VideoDto[]> {
    const rows = await this.prisma.video.findMany({
      where: { ...owner, deletedAt: null },
      include: { _count: { select: { reports: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r, true));
  }

  private countActive(
    db: Prisma.TransactionClient,
    owner: { barbershopId?: string; barberProfileId?: string },
  ): Promise<number> {
    return db.video.count({
      where: { ...owner, deletedAt: null, removedAt: null, status: { not: 'FAILED' } },
    });
  }

  private async ownProfile(userId: string): Promise<{ id: string }> {
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

  private toDto(
    r: {
      id: string;
      status: 'PROCESSING' | 'READY' | 'FAILED';
      variants: Prisma.JsonValue;
      durationMs: number | null;
      caption: string | null;
      failureReason: string | null;
      createdAt: Date;
    },
    forOwner: boolean,
  ): VideoDto {
    const keys = (r.variants ?? {}) as VideoKeys;
    const ready = r.status === 'READY';
    return {
      id: r.id,
      status: r.status,
      videoUrl: ready && keys.video ? this.storage.publicUrl(keys.video) : null,
      posterUrl: ready && keys.poster ? this.storage.publicUrl(keys.poster) : null,
      durationMs: r.durationMs,
      caption: r.caption,
      failureReason: forOwner ? r.failureReason : null,
      createdAt: r.createdAt,
    };
  }

  private async deleteFiles(keys: string[]): Promise<void> {
    if (keys.length === 0 || !this.storage.enabled) return;
    try {
      await this.storage.delete(keys);
    } catch (error) {
      this.logger.error(
        { err: (error as Error).name, count: keys.length },
        'No se pudieron borrar archivos de video',
      );
    }
  }
}

const limitReached = (max: number): AppException =>
  new AppException(
    ErrorCode.VIDEO_LIMIT_REACHED,
    `Puedes tener como máximo ${max} videos. Borra alguno para subir otro.`,
    HttpStatus.CONFLICT,
    [{ limit: max }],
  );
