import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { StaffActor } from '../admin/admin-access';
import { CommunityPolicy } from '../community/community-policy';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { variantUrl } from '../images/image-variants';
import type {
  AdminForumCategoryDto,
  AdminThreadDto,
  AdminThreadsQueryDto,
  CreateForumCategoryDto,
  CreateReplyDto,
  CreateThreadDto,
  ForumAuthorDto,
  ForumCategoryDto,
  ModerateThreadDto,
  RepliesQueryDto,
  ReplyDto,
  ReplyPageDto,
  ThreadDto,
  ThreadPageDto,
  ThreadsQueryDto,
  ThreadSummaryDto,
  UpdateForumCategoryDto,
  UpdateReplyDto,
  UpdateThreadDto,
} from './dto/forum.dto';

export const FORUM_EVENTS = {
  replied: 'forum.replied',
  solved: 'forum.solved',
} as const;

type Tx = Prisma.TransactionClient;

const authorSelect = {
  id: true,
  username: true,
  photoVariants: true,
  anonymizedAt: true,
  barberProfile: { select: { deletedAt: true } },
} satisfies Prisma.UserSelect;
type AuthorRow = Prisma.UserGetPayload<{ select: typeof authorSelect }>;

const threadInclude = {
  author: { select: authorSelect },
  category: { select: { name: true } },
} satisfies Prisma.ForumThreadInclude;
type ThreadRow = Prisma.ForumThreadGetPayload<{ include: typeof threadInclude }>;

const replyInclude = { author: { select: authorSelect } } satisfies Prisma.ForumReplyInclude;
type ReplyRow = Prisma.ForumReplyGetPayload<{ include: typeof replyInclude }>;

/** Visible para todos: ni borrado, ni retirado, ni oculto por reportes. */
const VISIBLE = { deletedAt: null, removedAt: null, hiddenAt: null } as const;

const notFound = (what = 'El hilo no existe.'): AppException =>
  new AppException(ErrorCode.NOT_FOUND, what, HttpStatus.NOT_FOUND);
const forbidden = (message: string): AppException =>
  new AppException(ErrorCode.FORBIDDEN, message, HttpStatus.FORBIDDEN);
const blocked = (): AppException =>
  new AppException(
    ErrorCode.BLOCKED,
    'No puedes interactuar con esta cuenta (hay un bloqueo entre ustedes).',
    HttpStatus.FORBIDDEN,
  );
const invalid = (field: string, constraint: string, message: string): AppException =>
  new AppException(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, [
    { field, constraints: [constraint] },
  ]);

const offsetOf = (cursor: string | undefined): number => {
  const n = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const cursorFor = (offset: number): string => Buffer.from(String(offset)).toString('base64url');

interface Viewer {
  id: string;
  /** Cuentas bloqueadas por mí o que me bloquearon. */
  blocked: Set<string>;
}

/**
 * Foros: preguntas y respuestas por tema, abiertos a cualquier cuenta (clientes, barberos y
 * barberías). A diferencia de la Comunidad (publicaciones de barberías y barberos), aquí cualquiera
 * pregunta y la mejor respuesta queda marcada. Usa las mismas reglas: palabras bloqueadas, límites
 * por cuenta, bloqueos entre cuentas y reportes con ocultado automático.
 */
@Injectable()
export class ForumsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: CommunityPolicy,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Temas ─────────────

  async categories(): Promise<ForumCategoryDto[]> {
    const rows = await this.prisma.forumCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      threadCount: c.threadCount,
    }));
  }

  // ───────────── Hilos ─────────────

  async threads(userId: string | undefined, query: ThreadsQueryDto): Promise<ThreadPageDto> {
    const viewer = await this.viewer(userId);
    const sort = query.sort ?? 'recent';
    const limit = query.limit ?? 20;
    const offset = offsetOf(query.cursor);
    const rows = await this.prisma.forumThread.findMany({
      where: {
        ...VISIBLE,
        category: { isActive: true },
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
        ...(sort === 'unanswered' ? { replyCount: 0, lockedAt: null } : {}),
        ...(viewer?.blocked.size ? { authorId: { notIn: [...viewer.blocked] } } : {}),
      },
      orderBy:
        sort === 'recent'
          ? [
              { pinnedAt: { sort: 'desc', nulls: 'last' } },
              { lastActivityAt: 'desc' },
              { id: 'desc' },
            ]
          : [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit + 1,
      include: threadInclude,
    });
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((r) => this.summary(r)),
      nextCursor: hasMore ? cursorFor(offset + limit) : null,
    };
  }

  async thread(userId: string | undefined, threadId: string): Promise<ThreadDto> {
    const viewer = await this.viewer(userId);
    const row = await this.readable(threadId, viewer);
    return this.full(row, viewer);
  }

  async createThread(userId: string, dto: CreateThreadDto): Promise<ThreadDto> {
    await this.policy.assertAllowed(dto.title, 'title');
    await this.policy.assertAllowed(dto.body);
    await this.policy.limitPosts(userId);
    const category = await this.prisma.forumCategory.count({
      where: { id: dto.categoryId, isActive: true },
    });
    if (!category) throw invalid('categoryId', 'exists', 'El tema no existe.');
    const now = new Date(this.clock.now());
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.forumThread.create({
        data: {
          categoryId: dto.categoryId,
          authorId: userId,
          title: dto.title,
          body: dto.body,
          lastActivityAt: now,
          createdAt: now,
        },
        select: { id: true },
      });
      await tx.forumCategory.update({
        where: { id: dto.categoryId },
        data: { threadCount: { increment: 1 } },
      });
      return created.id;
    });
    return this.thread(userId, id);
  }

  async updateThread(userId: string, threadId: string, dto: UpdateThreadDto): Promise<ThreadDto> {
    const row = await this.own(threadId, userId);
    if (row.removedAt) throw this.hidden();
    if (dto.title !== undefined) await this.policy.assertAllowed(dto.title, 'title');
    if (dto.body !== undefined) await this.policy.assertAllowed(dto.body);
    await this.prisma.forumThread.update({
      where: { id: threadId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.body !== undefined ? { body: dto.body } : {}),
        editedAt: new Date(this.clock.now()),
      },
    });
    return this.thread(userId, threadId);
  }

  async deleteThread(userId: string, threadId: string): Promise<void> {
    const row = await this.own(threadId, userId);
    await this.prisma.$transaction(async (tx) => {
      await tx.forumThread.update({
        where: { id: threadId },
        data: { deletedAt: new Date(this.clock.now()) },
      });
      if (!row.removedAt) await this.countThread(tx, row.categoryId, -1);
    });
  }

  // ───────────── Respuestas ─────────────

  async replies(
    userId: string | undefined,
    threadId: string,
    query: RepliesQueryDto,
  ): Promise<ReplyPageDto> {
    const viewer = await this.viewer(userId);
    const thread = await this.readable(threadId, viewer);
    const limit = query.limit ?? 20;
    const offset = offsetOf(query.cursor);
    const where: Prisma.ForumReplyWhereInput = {
      threadId,
      ...VISIBLE,
      ...(viewer?.blocked.size ? { authorId: { notIn: [...viewer.blocked] } } : {}),
    };
    // La mejor respuesta va primero (solo en la primera página) y no se repite después.
    const solution =
      thread.solutionReplyId && offset === 0
        ? await this.prisma.forumReply.findFirst({
            where: { ...where, id: thread.solutionReplyId },
            include: replyInclude,
          })
        : null;
    const rows = await this.prisma.forumReply.findMany({
      where: {
        ...where,
        ...(thread.solutionReplyId ? { id: { not: thread.solutionReplyId } } : {}),
      },
      orderBy:
        query.sort === 'helpful'
          ? [{ helpfulCount: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }]
          : [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: limit + 1,
      include: replyInclude,
    });
    const hasMore = rows.length > limit;
    const page = [...(solution ? [solution] : []), ...rows.slice(0, limit)];
    return {
      items: await this.replyDtos(page, thread.solutionReplyId, viewer),
      nextCursor: hasMore ? cursorFor(offset + limit) : null,
    };
  }

  async reply(userId: string, threadId: string, dto: CreateReplyDto): Promise<ReplyDto> {
    const viewer = (await this.viewer(userId))!;
    await this.policy.assertAllowed(dto.body);
    await this.policy.limitComments(userId);
    const thread = await this.readable(threadId, viewer);
    if (thread.lockedAt) {
      throw new AppException(
        ErrorCode.THREAD_LOCKED,
        'El hilo está cerrado: ya no admite respuestas.',
        HttpStatus.CONFLICT,
      );
    }
    const now = new Date(this.clock.now());
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.forumReply.create({
        data: { threadId, authorId: userId, body: dto.body, createdAt: now },
        select: { id: true },
      });
      await tx.forumThread.update({
        where: { id: threadId },
        data: { replyCount: { increment: 1 }, lastActivityAt: now },
      });
      await this.outbox.publish(tx, FORUM_EVENTS.replied, { replyId: created.id });
      return created.id;
    });
    return this.replyOne(id, viewer);
  }

  async updateReply(userId: string, replyId: string, dto: UpdateReplyDto): Promise<ReplyDto> {
    const reply = await this.ownReply(replyId, userId);
    if (reply.removedAt) throw this.hidden('La respuesta');
    await this.policy.assertAllowed(dto.body);
    await this.prisma.forumReply.update({
      where: { id: replyId },
      data: { body: dto.body, editedAt: new Date(this.clock.now()) },
    });
    return this.replyOne(replyId, await this.viewer(userId));
  }

  async deleteReply(userId: string, replyId: string): Promise<void> {
    const reply = await this.ownReply(replyId, userId);
    await this.prisma.$transaction(async (tx) => {
      await tx.forumReply.update({
        where: { id: replyId },
        data: { deletedAt: new Date(this.clock.now()) },
      });
      await tx.forumThread.updateMany({
        where: { id: reply.threadId, solutionReplyId: replyId },
        data: { solutionReplyId: null },
      });
      if (!reply.removedAt) {
        await tx.forumThread.update({
          where: { id: reply.threadId },
          data: { replyCount: { decrement: 1 } },
        });
      }
    });
  }

  /** "Me sirvió": un voto por cuenta; no en las respuestas propias. Idempotente. */
  async vote(userId: string, replyId: string, helpful: boolean): Promise<ReplyDto> {
    const viewer = (await this.viewer(userId))!;
    await this.policy.limitActions(userId);
    const reply = await this.prisma.forumReply.findFirst({
      where: { id: replyId, ...VISIBLE },
      select: { authorId: true, threadId: true },
    });
    if (!reply) throw notFound('La respuesta no existe.');
    await this.readable(reply.threadId, viewer);
    if (reply.authorId === userId) {
      throw forbidden('No puedes votar tu propia respuesta.');
    }
    if (viewer.blocked.has(reply.authorId)) throw blocked();
    await this.prisma.$transaction(async (tx) => {
      if (helpful) {
        const { count } = await tx.forumReplyVote.createMany({
          data: [{ replyId, userId }],
          skipDuplicates: true,
        });
        if (count) {
          await tx.forumReply.update({
            where: { id: replyId },
            data: { helpfulCount: { increment: 1 } },
          });
        }
      } else {
        const { count } = await tx.forumReplyVote.deleteMany({ where: { replyId, userId } });
        if (count) {
          await tx.forumReply.update({
            where: { id: replyId },
            data: { helpfulCount: { decrement: 1 } },
          });
        }
      }
    });
    return this.replyOne(replyId, viewer);
  }

  /** Quien abrió el hilo marca (o cambia) la respuesta que resolvió su duda. */
  async markSolution(userId: string, threadId: string, replyId: string): Promise<ThreadDto> {
    const thread = await this.own(threadId, userId);
    if (thread.removedAt) throw this.hidden();
    const reply = await this.prisma.forumReply.findFirst({
      where: { id: replyId, threadId, ...VISIBLE },
      select: { authorId: true },
    });
    if (!reply) throw invalid('replyId', 'exists', 'La respuesta no es de este hilo.');
    if (thread.solutionReplyId !== replyId) {
      await this.prisma.$transaction(async (tx) => {
        await tx.forumThread.update({
          where: { id: threadId },
          data: { solutionReplyId: replyId },
        });
        if (reply.authorId !== userId) {
          await this.outbox.publish(tx, FORUM_EVENTS.solved, { replyId });
        }
      });
    }
    return this.thread(userId, threadId);
  }

  async clearSolution(userId: string, threadId: string): Promise<ThreadDto> {
    await this.own(threadId, userId);
    await this.prisma.forumThread.update({
      where: { id: threadId },
      data: { solutionReplyId: null },
    });
    return this.thread(userId, threadId);
  }

  // ───────────── Panel ─────────────

  async adminCategories(): Promise<AdminForumCategoryDto[]> {
    const rows = await this.prisma.forumCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      threadCount: c.threadCount,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
    }));
  }

  async createCategory(
    actor: StaffActor,
    dto: CreateForumCategoryDto,
  ): Promise<AdminForumCategoryDto> {
    if (await this.prisma.forumCategory.count({ where: { slug: dto.slug } })) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Ya existe un tema con ese identificador.',
        HttpStatus.CONFLICT,
        [{ field: 'slug', constraints: ['unique'] }],
      );
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.forumCategory.create({
        data: {
          slug: dto.slug,
          name: dto.name,
          description: dto.description ?? null,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      await this.record(tx, actor, 'forum_category.created', 'forum_category', created.id);
      return created.id;
    });
    return (await this.adminCategories()).find((c) => c.id === id)!;
  }

  async updateCategory(
    actor: StaffActor,
    categoryId: string,
    dto: UpdateForumCategoryDto,
  ): Promise<AdminForumCategoryDto> {
    if (!(await this.prisma.forumCategory.count({ where: { id: categoryId } }))) {
      throw notFound('El tema no existe.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.forumCategory.update({
        where: { id: categoryId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      await this.record(tx, actor, 'forum_category.updated', 'forum_category', categoryId, {
        fields: Object.keys(dto),
      });
    });
    return (await this.adminCategories()).find((c) => c.id === categoryId)!;
  }

  async adminThreads(query: AdminThreadsQueryDto): Promise<AdminThreadDto[]> {
    const state = query.state ?? 'ALL';
    const rows = await this.prisma.forumThread.findMany({
      where: {
        deletedAt: null,
        ...(state === 'REPORTED' ? { reportCount: { gt: 0 }, removedAt: null } : {}),
        ...(state === 'HIDDEN' ? { hiddenAt: { not: null }, removedAt: null } : {}),
        ...(state === 'REMOVED' ? { removedAt: { not: null } } : {}),
        ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: threadInclude,
    });
    return rows.map((r) => this.adminDto(r));
  }

  /** Soporte: fijar, cerrar, mover de tema o retirar un hilo. Auditado. */
  async moderateThread(
    actor: StaffActor,
    threadId: string,
    dto: ModerateThreadDto,
  ): Promise<AdminThreadDto> {
    const row = await this.prisma.forumThread.findFirst({
      where: { id: threadId, deletedAt: null },
    });
    if (!row) throw notFound();
    if (dto.categoryId && dto.categoryId !== row.categoryId) {
      if (!(await this.prisma.forumCategory.count({ where: { id: dto.categoryId } }))) {
        throw invalid('categoryId', 'exists', 'El tema no existe.');
      }
    }
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.ForumThreadUncheckedUpdateInput = {};
      if (dto.pinned !== undefined) data.pinnedAt = dto.pinned ? now : null;
      if (dto.locked !== undefined) data.lockedAt = dto.locked ? now : null;
      const wasCounted = !row.removedAt;
      const counted = dto.removed === undefined ? wasCounted : !dto.removed;
      if (dto.removed !== undefined) {
        data.removedAt = dto.removed ? (row.removedAt ?? now) : null;
        if (!dto.removed) {
          data.hiddenAt = null;
          data.reportCount = 0;
        }
      }
      const category = dto.categoryId ?? row.categoryId;
      if (category !== row.categoryId) data.categoryId = category;
      await tx.forumThread.update({ where: { id: threadId }, data });
      if (wasCounted) await this.countThread(tx, row.categoryId, -1);
      if (counted) await this.countThread(tx, category, 1);
      await this.record(tx, actor, 'forum_thread.moderated', 'forum_thread', threadId, {
        ...dto,
      });
    });
    return this.adminOne(threadId);
  }

  private async adminOne(threadId: string): Promise<AdminThreadDto> {
    const r = await this.prisma.forumThread.findUniqueOrThrow({
      where: { id: threadId },
      include: threadInclude,
    });
    return this.adminDto(r);
  }

  private adminDto(r: ThreadRow): AdminThreadDto {
    return {
      ...this.summary(r),
      state: r.deletedAt ? 'DELETED' : r.removedAt ? 'REMOVED' : r.hiddenAt ? 'HIDDEN' : 'VISIBLE',
      reportCount: r.reportCount,
    };
  }

  // ───────────── Internos ─────────────

  private async viewer(userId: string | undefined): Promise<Viewer | null> {
    if (!userId) return null;
    const blocks = await this.prisma.userBlock.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    return {
      id: userId,
      blocked: new Set(blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId))),
    };
  }

  /** Hilo que quien mira puede leer: no borrado ni retirado; oculto solo para su autor. */
  private async readable(threadId: string, viewer: Viewer | null): Promise<ThreadRow> {
    const row = await this.prisma.forumThread.findFirst({
      where: { id: threadId, deletedAt: null, category: { isActive: true } },
      include: threadInclude,
    });
    if (!row) throw notFound();
    if (viewer?.blocked.has(row.authorId)) throw notFound();
    if (row.removedAt || (row.hiddenAt && row.authorId !== viewer?.id)) throw this.hidden();
    return row;
  }

  private async own(threadId: string, userId: string): Promise<ThreadRow> {
    const row = await this.prisma.forumThread.findFirst({
      where: { id: threadId, deletedAt: null },
      include: threadInclude,
    });
    if (!row || row.authorId !== userId) throw notFound();
    return row;
  }

  private async ownReply(replyId: string, userId: string) {
    const reply = await this.prisma.forumReply.findFirst({
      where: { id: replyId, deletedAt: null },
      select: { threadId: true, authorId: true, removedAt: true },
    });
    if (!reply || reply.authorId !== userId) throw notFound('La respuesta no existe.');
    return reply;
  }

  private hidden(what = 'El hilo'): AppException {
    return new AppException(
      ErrorCode.THREAD_HIDDEN,
      `${what} ya no está disponible (fue retirado o está en revisión).`,
      HttpStatus.GONE,
    );
  }

  private countThread(tx: Tx, categoryId: string, delta: 1 | -1): Promise<unknown> {
    return delta > 0
      ? tx.forumCategory.update({
          where: { id: categoryId },
          data: { threadCount: { increment: 1 } },
        })
      : tx.forumCategory.updateMany({
          where: { id: categoryId, threadCount: { gt: 0 } },
          data: { threadCount: { decrement: 1 } },
        });
  }

  private author(u: AuthorRow): ForumAuthorDto {
    return {
      userId: u.id,
      username: u.anonymizedAt ? 'Cuenta eliminada' : u.username,
      photoUrl: u.anonymizedAt ? null : variantUrl(this.storage, u.photoVariants, 'square'),
      isBarber: !u.anonymizedAt && !!u.barberProfile && !u.barberProfile.deletedAt,
    };
  }

  private summary(r: ThreadRow): ThreadSummaryDto {
    return {
      id: r.id,
      categoryId: r.categoryId,
      categoryName: r.category.name,
      title: r.title,
      excerpt: r.body.slice(0, 200),
      author: this.author(r.author),
      replyCount: r.replyCount,
      solved: r.solutionReplyId !== null,
      pinned: r.pinnedAt !== null,
      locked: r.lockedAt !== null,
      lastActivityAt: r.lastActivityAt,
      createdAt: r.createdAt,
    };
  }

  private full(r: ThreadRow, viewer: Viewer | null): ThreadDto {
    return {
      ...this.summary(r),
      body: r.body,
      solutionReplyId: r.solutionReplyId,
      isMine: viewer?.id === r.authorId,
      editedAt: r.editedAt,
    };
  }

  private async replyOne(replyId: string, viewer: Viewer | null): Promise<ReplyDto> {
    const row = await this.prisma.forumReply.findUniqueOrThrow({
      where: { id: replyId },
      include: { ...replyInclude, thread: { select: { solutionReplyId: true } } },
    });
    return (await this.replyDtos([row], row.thread.solutionReplyId, viewer))[0]!;
  }

  private async replyDtos(
    rows: ReplyRow[],
    solutionReplyId: string | null,
    viewer: Viewer | null,
  ): Promise<ReplyDto[]> {
    const voted = viewer
      ? new Set(
          (
            await this.prisma.forumReplyVote.findMany({
              where: { userId: viewer.id, replyId: { in: rows.map((r) => r.id) } },
              select: { replyId: true },
            })
          ).map((v) => v.replyId),
        )
      : new Set<string>();
    return rows.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      author: this.author(r.author),
      body: r.body,
      helpful: r.helpfulCount,
      votedHelpful: voted.has(r.id),
      isSolution: r.id === solutionReplyId,
      isMine: viewer?.id === r.authorId,
      editedAt: r.editedAt,
      createdAt: r.createdAt,
    }));
  }

  private record(
    tx: Tx,
    actor: StaffActor,
    action: string,
    entityType: string,
    entityId: string,
    changes?: Prisma.InputJsonValue,
  ): Promise<void> {
    return this.audit.record(
      {
        actorId: actor.id,
        action,
        entityType,
        entityId,
        changes: { ...(changes as object), role: actor.role },
      },
      tx,
    );
  }
}
