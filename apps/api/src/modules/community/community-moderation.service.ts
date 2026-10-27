import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { StaffActor } from '../admin/admin-access';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { variantUrl } from '../images/image-variants';
import { CommunityPolicy } from './community-policy';
import type {
  AdminContentReportDto,
  AdminReportsQueryDto,
  CreateContentReportDto,
  ResolveReportDto,
} from './dto/community.dto';

type Tx = Prisma.TransactionClient;
const TARGET = {
  post: 'POST',
  comment: 'COMMENT',
  user: 'USER',
  forum_thread: 'FORUM_THREAD',
  forum_reply: 'FORUM_REPLY',
} as const;

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El contenido reportado no existe.', HttpStatus.NOT_FOUND);

/**
 * Moderación de la comunidad (exigida por las tiendas): reportes de publicaciones, comentarios y
 * cuentas; ocultado automático al llegar a N reportes de personas distintas; revisión en el panel.
 */
@Injectable()
export class CommunityModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: CommunityPolicy,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Idempotente: el mismo reporte dos veces no suma. Nunca revela si ocultó el contenido. */
  async report(userId: string, dto: CreateContentReportDto): Promise<void> {
    await this.policy.limitActions(userId);
    const targetType = TARGET[dto.targetType];
    if (targetType === 'USER') {
      if (dto.targetId === userId) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'No puedes reportarte a ti mismo.',
          HttpStatus.BAD_REQUEST,
          [{ field: 'targetId', constraints: ['notSelf'] }],
        );
      }
      if (!(await this.prisma.user.count({ where: { id: dto.targetId } }))) throw notFound();
    } else if (targetType === 'POST') {
      if (!(await this.prisma.post.count({ where: { id: dto.targetId, deletedAt: null } })))
        throw notFound();
    } else if (targetType === 'FORUM_THREAD') {
      if (!(await this.prisma.forumThread.count({ where: { id: dto.targetId, deletedAt: null } })))
        throw notFound();
    } else if (targetType === 'FORUM_REPLY') {
      if (!(await this.prisma.forumReply.count({ where: { id: dto.targetId, deletedAt: null } })))
        throw notFound();
    } else if (
      !(await this.prisma.postComment.count({ where: { id: dto.targetId, deletedAt: null } }))
    ) {
      throw notFound();
    }
    const threshold = await this.policy.reportHideThreshold();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.contentReport.createMany({
        data: [
          {
            reporterId: userId,
            targetType,
            targetId: dto.targetId,
            reason: dto.reason,
            note: dto.note ?? null,
          },
        ],
        skipDuplicates: true,
      });
      if (!count || targetType === 'USER') return;
      const open = await tx.contentReport.count({
        where: { targetType, targetId: dto.targetId, status: 'OPEN' },
      });
      const now = new Date(this.clock.now());
      const data = { reportCount: open, ...(open >= threshold ? { hiddenAt: now } : {}) };
      if (targetType === 'FORUM_THREAD') {
        await tx.forumThread.update({ where: { id: dto.targetId }, data });
      } else if (targetType === 'FORUM_REPLY') {
        await tx.forumReply.update({ where: { id: dto.targetId }, data });
      } else if (targetType === 'POST') {
        await tx.post.update({
          where: { id: dto.targetId },
          data: { reportCount: open, ...(open >= threshold ? { hiddenAt: now } : {}) },
        });
      } else {
        await tx.postComment.update({
          where: { id: dto.targetId },
          data: { reportCount: open, ...(open >= threshold ? { hiddenAt: now } : {}) },
        });
      }
    });
  }

  // ───────────── Panel ─────────────

  async list(query: AdminReportsQueryDto): Promise<AdminContentReportDto[]> {
    const rows = await this.prisma.contentReport.findMany({
      where: {
        status: query.status ?? 'OPEN',
        ...(query.targetType ? { targetType: query.targetType } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { reporter: { select: { username: true } } },
    });
    const ids = (t: string) => [
      ...new Set(rows.filter((r) => r.targetType === t).map((r) => r.targetId)),
    ];
    const [posts, comments, users, openCounts, threads, forumReplies] = await Promise.all([
      this.prisma.post.findMany({
        where: { id: { in: ids('POST') } },
        select: {
          id: true,
          body: true,
          hiddenAt: true,
          removedAt: true,
          deletedAt: true,
          createdBy: { select: { username: true } },
          media: { select: { variants: true }, orderBy: { sortOrder: 'asc' } },
        },
      }),
      this.prisma.postComment.findMany({
        where: { id: { in: ids('COMMENT') } },
        select: {
          id: true,
          body: true,
          hiddenAt: true,
          removedAt: true,
          deletedAt: true,
          author: { select: { username: true } },
        },
      }),
      this.prisma.user.findMany({
        where: { id: { in: ids('USER') } },
        select: { id: true, username: true, status: true, deletedAt: true },
      }),
      this.prisma.contentReport.groupBy({
        by: ['targetType', 'targetId'],
        where: { status: 'OPEN', targetId: { in: rows.map((r) => r.targetId) } },
        _count: { _all: true },
      }),
      this.prisma.forumThread.findMany({
        where: { id: { in: ids('FORUM_THREAD') } },
        select: {
          id: true,
          title: true,
          body: true,
          hiddenAt: true,
          removedAt: true,
          deletedAt: true,
          author: { select: { username: true } },
        },
      }),
      this.prisma.forumReply.findMany({
        where: { id: { in: ids('FORUM_REPLY') } },
        select: {
          id: true,
          body: true,
          hiddenAt: true,
          removedAt: true,
          deletedAt: true,
          author: { select: { username: true } },
          thread: { select: { title: true } },
        },
      }),
    ]);
    const threadById = new Map(threads.map((t) => [t.id, t]));
    const forumReplyById = new Map(forumReplies.map((t) => [t.id, t]));
    const postById = new Map(posts.map((p) => [p.id, p]));
    const commentById = new Map(comments.map((c) => [c.id, c]));
    const userById = new Map(users.map((u) => [u.id, u]));
    const open = new Map(openCounts.map((o) => [`${o.targetType}:${o.targetId}`, o._count._all]));
    const state = (c: { hiddenAt: Date | null; removedAt: Date | null; deletedAt: Date | null }) =>
      c.deletedAt ? 'DELETED' : c.removedAt ? 'REMOVED' : c.hiddenAt ? 'HIDDEN' : 'VISIBLE';
    return rows.map((r) => {
      const post = postById.get(r.targetId);
      const comment = commentById.get(r.targetId);
      const user = userById.get(r.targetId);
      const base = {
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        note: r.note,
        status: r.status,
        reporter: r.reporter.username,
        openReports: open.get(`${r.targetType}:${r.targetId}`) ?? 0,
        resolution: r.resolution,
        createdAt: r.createdAt,
      };
      if (r.targetType === 'POST' && post) {
        return {
          ...base,
          preview: post.body.slice(0, 500),
          targetAuthor: post.createdBy.username,
          targetState: state(post),
          photos: post.media.flatMap((m) => {
            const url = variantUrl(this.storage, m.variants, 'thumb');
            return url ? [url] : [];
          }),
        };
      }
      const thread = threadById.get(r.targetId);
      if (r.targetType === 'FORUM_THREAD' && thread) {
        return {
          ...base,
          preview: `Foro: ${thread.title}\n\n${thread.body}`.slice(0, 500),
          targetAuthor: thread.author.username,
          targetState: state(thread),
          photos: [],
        };
      }
      const forumReply = forumReplyById.get(r.targetId);
      if (r.targetType === 'FORUM_REPLY' && forumReply) {
        return {
          ...base,
          preview: `Respuesta en «${forumReply.thread.title}»: ${forumReply.body}`.slice(0, 500),
          targetAuthor: forumReply.author.username,
          targetState: state(forumReply),
          photos: [],
        };
      }
      if (r.targetType === 'COMMENT' && comment) {
        return {
          ...base,
          preview: comment.body.slice(0, 500),
          targetAuthor: comment.author.username,
          targetState: state(comment),
          photos: [],
        };
      }
      return {
        ...base,
        preview: user ? `Cuenta @${user.username}` : 'Cuenta eliminada',
        targetAuthor: user?.username ?? null,
        targetState: user?.deletedAt
          ? 'DELETED'
          : user?.status === 'ACTIVE'
            ? 'VISIBLE'
            : 'REMOVED',
        photos: [],
      };
    });
  }

  /** Resuelve todos los reportes abiertos del mismo objetivo. Auditado. */
  async resolve(
    actor: StaffActor,
    reportId: string,
    dto: ResolveReportDto,
  ): Promise<AdminContentReportDto> {
    const report = await this.prisma.contentReport.findUnique({ where: { id: reportId } });
    if (!report) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El reporte no existe.', HttpStatus.NOT_FOUND);
    }
    if (report.targetType === 'USER' && dto.action !== 'DISMISS') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Las cuentas se suspenden desde "Cuentas". Aquí solo se descarta el reporte.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'action', constraints: ['userReport'] }],
      );
    }
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      await this.applyAction(tx, report.targetType, report.targetId, dto.action, now);
      await tx.contentReport.updateMany({
        where: { targetType: report.targetType, targetId: report.targetId, status: 'OPEN' },
        data: {
          status: dto.action === 'REMOVE' ? 'ACTIONED' : 'DISMISSED',
          reviewedById: actor.id,
          reviewedAt: now,
          resolution: dto.reason,
        },
      });
      if (dto.action === 'RESTORE') {
        await tx.contentReport.updateMany({
          where: { id: reportId },
          data: { resolution: dto.reason, reviewedById: actor.id, reviewedAt: now },
        });
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: `community.report_${dto.action.toLowerCase()}`,
          entityType: report.targetType.toLowerCase(),
          entityId: report.targetId,
          changes: { reportId, reason: dto.reason, role: actor.role },
        },
        tx,
      );
    });
    const [updated] = await this.listOne(reportId);
    return updated!;
  }

  private async listOne(reportId: string): Promise<AdminContentReportDto[]> {
    const report = await this.prisma.contentReport.findUniqueOrThrow({ where: { id: reportId } });
    const all = await this.list({ status: report.status, targetType: report.targetType });
    return all.filter((r) => r.id === reportId);
  }

  private async applyAction(
    tx: Tx,
    targetType: string,
    targetId: string,
    action: ResolveReportDto['action'],
    now: Date,
  ): Promise<void> {
    if (targetType === 'USER') return;
    const data =
      action === 'REMOVE'
        ? { removedAt: now }
        : action === 'RESTORE'
          ? { removedAt: null, hiddenAt: null, reportCount: 0 }
          : { hiddenAt: null, reportCount: 0 };
    if (targetType === 'POST') await tx.post.update({ where: { id: targetId }, data });
    else if (targetType === 'COMMENT')
      await tx.postComment.update({ where: { id: targetId }, data });
    else if (targetType === 'FORUM_REPLY') await this.moderateForumReply(tx, targetId, data);
    else await this.moderateForumThread(tx, targetId, data);
  }

  /** Hilo del foro: al retirarlo o restaurarlo se ajusta el contador de su tema. */
  private async moderateForumThread(
    tx: Tx,
    id: string,
    data: { removedAt?: Date | null; hiddenAt?: null; reportCount?: number },
  ): Promise<void> {
    const before = await tx.forumThread.findUniqueOrThrow({
      where: { id },
      select: { removedAt: true, deletedAt: true, categoryId: true },
    });
    await tx.forumThread.update({ where: { id }, data });
    if (before.deletedAt || data.removedAt === undefined) return;
    const wasCounted = !before.removedAt;
    const counted = data.removedAt === null;
    if (wasCounted === counted) return;
    await tx.forumCategory.updateMany({
      where: { id: before.categoryId, ...(counted ? {} : { threadCount: { gt: 0 } }) },
      data: { threadCount: counted ? { increment: 1 } : { decrement: 1 } },
    });
  }

  /** Respuesta del foro: retirada deja de contar en el hilo y deja de ser la mejor respuesta. */
  private async moderateForumReply(
    tx: Tx,
    id: string,
    data: { removedAt?: Date | null; hiddenAt?: null; reportCount?: number },
  ): Promise<void> {
    const before = await tx.forumReply.findUniqueOrThrow({
      where: { id },
      select: { removedAt: true, deletedAt: true, threadId: true },
    });
    await tx.forumReply.update({ where: { id }, data });
    if (before.deletedAt || data.removedAt === undefined) return;
    const wasCounted = !before.removedAt;
    const counted = data.removedAt === null;
    if (wasCounted === counted) return;
    await tx.forumThread.update({
      where: { id: before.threadId },
      data: { replyCount: counted ? { increment: 1 } : { decrement: 1 } },
    });
    if (!counted) {
      await tx.forumThread.updateMany({
        where: { id: before.threadId, solutionReplyId: id },
        data: { solutionReplyId: null },
      });
    }
  }
}
