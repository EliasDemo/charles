import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { ConversationKind, MessageSide } from '../../generated/prisma/enums';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { barbershopMedia } from '../images/barbershop-media';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { variantUrl } from '../images/image-variants';
import type {
  ConversationDto,
  ConversationPageDto,
  MessageDto,
  MessagePageDto,
  MessageReportPageDto,
  ReportMessageDto,
  ResolveMessageReportDto,
} from './dto/messaging.dto';

const DEFAULT_LIMIT = 20;
const PREVIEW_LENGTH = 120;
const REMOVED_TEXT = 'Mensaje retirado por soporte.';

/** Quién mira la conversación: la persona, o la barbería (uno de sus OWNER o MANAGER). */
type Viewer =
  { side: 'USER'; userId: string } | { side: 'BARBERSHOP'; userId: string; barbershopId: string };

const conversationInclude = {
  barbershop: { select: { id: true, name: true } },
  user: {
    select: {
      id: true,
      fullName: true,
      username: true,
      photoVariants: true,
      barberProfile: {
        select: { id: true, displayName: true, photoVariants: true, deletedAt: true },
      },
    },
  },
  messages: { orderBy: { createdAt: 'desc' as const }, take: 1 },
} satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La conversación no existe.', HttpStatus.NOT_FOUND);

const blocked = (): AppException =>
  new AppException(
    ErrorCode.CONVERSATION_BLOCKED,
    'Esta conversación está bloqueada: no se pueden enviar mensajes.',
    HttpStatus.CONFLICT,
  );

/**
 * Correo interno (Carrera del barbero): conversaciones entre una barbería (sus OWNER y MANAGER) y
 * una persona (cliente o barbero). Mensajes cifrados; aviso por push, bandeja y correo (sin el
 * contenido). La barbería no escribe primero a clientes (evita el spam); sí a barberos.
 */
@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly encryption: EncryptionService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Lado de la persona ─────────────

  listForUser(
    userId: string,
    query: { cursor?: string; limit?: number },
  ): Promise<ConversationPageDto> {
    return this.list({ side: 'USER', userId }, { userId }, query);
  }

  async startAsUser(
    userId: string,
    input: { barbershopId: string; body: string; kind?: ConversationKind },
  ): Promise<MessagePageDto> {
    const kind = input.kind ?? 'CLIENT';
    await this.access.requirePublic(input.barbershopId);
    if (await this.access.isMember(input.barbershopId, userId)) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'No puedes escribirle a tu propia barbería.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (kind === 'PROFESSIONAL') {
      const profile = await this.prisma.barberProfile.count({ where: { userId, deletedAt: null } });
      if (!profile) {
        throw new AppException(
          ErrorCode.FORBIDDEN,
          'Para escribir como barbero, crea primero tu perfil profesional.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const conversation = await this.ensure(tx, input.barbershopId, userId, kind);
      await this.post(tx, conversation, 'USER', userId, input.body);
      return conversation.id;
    });
    return this.messages({ side: 'USER', userId }, id, {});
  }

  // ───────────── Lado de la barbería ─────────────

  async listForShop(
    actorId: string,
    barbershopId: string,
    query: { cursor?: string; limit?: number },
  ): Promise<ConversationPageDto> {
    await this.access.requireMember(actorId, barbershopId);
    return this.list(
      { side: 'BARBERSHOP', userId: actorId, barbershopId },
      { barbershopId },
      query,
    );
  }

  /** La barbería escribe a un barbero desde su perfil profesional. */
  async contactBarber(
    actorId: string,
    barbershopId: string,
    input: { barberProfileId: string; body: string },
  ): Promise<MessagePageDto> {
    await this.access.requireMember(actorId, barbershopId);
    const profile = await this.prisma.barberProfile.findFirst({
      where: { id: input.barberProfileId, deletedAt: null },
      select: { userId: true },
    });
    if (!profile) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El barbero no existe.', HttpStatus.NOT_FOUND);
    }
    if (profile.userId === actorId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'No puedes escribirte a ti mismo.',
        HttpStatus.FORBIDDEN,
      );
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const conversation = await this.ensure(tx, barbershopId, profile.userId, 'PROFESSIONAL');
      await this.post(tx, conversation, 'BARBERSHOP', actorId, input.body);
      return conversation.id;
    });
    return this.messages({ side: 'BARBERSHOP', userId: actorId, barbershopId }, id, {});
  }

  async shopViewer(actorId: string, barbershopId: string): Promise<Viewer> {
    await this.access.requireMember(actorId, barbershopId);
    return { side: 'BARBERSHOP', userId: actorId, barbershopId };
  }

  userViewer(userId: string): Viewer {
    return { side: 'USER', userId };
  }

  // ───────────── Común a ambos lados ─────────────

  /** Mensajes (más recientes primero). La primera página marca la conversación como leída. */
  async messages(
    viewer: Viewer,
    conversationId: string,
    query: { cursor?: string; limit?: number },
  ): Promise<MessagePageDto> {
    const conversation = await this.find(viewer, conversationId);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const rows = await this.prisma.message.findMany({
      where: { conversationId, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: { sender: { select: { fullName: true, username: true } } },
    });
    if (!query.cursor) await this.markRead(viewer, conversationId);
    const page = rows.slice(0, limit);
    return {
      conversation: (await this.toConversations(viewer, [await this.reload(conversation.id)]))[0]!,
      items: page.map((m): MessageDto => ({
        id: m.id,
        side: m.side,
        mine: m.side === viewer.side,
        // La persona firma con su usuario; la barbería, con el nombre de pila de quien escribe.
        senderName:
          m.side === 'SYSTEM'
            ? 'Charles'
            : m.side === 'USER'
              ? (m.sender?.username ?? null)
              : firstName(m.sender?.fullName ?? null),
        body: m.removedAt
          ? REMOVED_TEXT
          : this.encryption.decrypt(m.bodyEnc, EncryptedField.MESSAGE_BODY),
        removed: m.removedAt !== null,
        createdAt: m.createdAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async send(viewer: Viewer, conversationId: string, body: string): Promise<MessageDto> {
    const conversation = await this.find(viewer, conversationId);
    const message = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ blocked_by: string | null }[]>`
        SELECT blocked_by::text AS blocked_by FROM conversations
         WHERE id = ${conversation.id}::uuid FOR UPDATE`;
      if (row?.blocked_by) throw blocked();
      return this.post(tx, conversation, viewer.side, viewer.userId, body);
    });
    return {
      id: message.id,
      side: viewer.side,
      mine: true,
      senderName: null,
      body,
      removed: false,
      createdAt: message.createdAt,
    };
  }

  async setBlocked(
    viewer: Viewer,
    conversationId: string,
    block: boolean,
  ): Promise<ConversationDto> {
    const conversation = await this.find(viewer, conversationId);
    if (!block && conversation.blockedBy && conversation.blockedBy !== viewer.side) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Solo quien bloqueó la conversación puede desbloquearla.',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { blockedBy: block ? viewer.side : null },
      });
      await this.audit.record(
        {
          actorId: viewer.userId,
          action: block ? 'conversation.blocked' : 'conversation.unblocked',
          entityType: 'conversation',
          entityId: conversationId,
          changes: { side: viewer.side },
        },
        tx,
      );
    });
    return (await this.toConversations(viewer, [await this.reload(conversationId)]))[0]!;
  }

  /** Reportar un mensaje del otro lado (una vez por persona). */
  async report(userId: string, messageId: string, dto: ReportMessageDto): Promise<void> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { side: true, conversation: { select: { userId: true, barbershopId: true } } },
    });
    if (!message) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El mensaje no existe.', HttpStatus.NOT_FOUND);
    }
    const isUser = message.conversation.userId === userId;
    const isShop = await this.access.isMember(message.conversation.barbershopId, userId);
    const ownSide = isUser ? 'USER' : isShop ? 'BARBERSHOP' : null;
    if (!ownSide) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El mensaje no existe.', HttpStatus.NOT_FOUND);
    }
    if (message.side === ownSide || message.side === 'SYSTEM') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'No puedes reportar este mensaje.',
        HttpStatus.FORBIDDEN,
      );
    }
    try {
      await this.prisma.messageReport.create({
        data: { messageId, reporterId: userId, reason: dto.reason, details: dto.details ?? null },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.ALREADY_REPORTED,
          'Ya reportaste este mensaje.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /** Conversaciones con mensajes sin leer (lado persona). */
  async unreadForUser(userId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(DISTINCT c.id)::int AS n FROM conversations c
        JOIN messages m ON m.conversation_id = c.id
       WHERE c.user_id = ${userId}::uuid AND m.side <> 'USER'
         AND (c.user_read_at IS NULL OR m.created_at > c.user_read_at)`;
    return row?.n ?? 0;
  }

  /**
   * Mensaje automático de Charles (postulaciones, contrataciones, invitaciones), en la transacción
   * de quien lo genera. Crea la conversación si no existe.
   */
  async postSystem(
    tx: Prisma.TransactionClient,
    input: { barbershopId: string; userId: string; kind: ConversationKind; body: string },
  ): Promise<void> {
    // En una conversación bloqueada no se envía nada (la acción que lo genera sigue su curso).
    const conversation = await this.ensure(tx, input.barbershopId, input.userId, input.kind, false);
    if (conversation.blockedBy) return;
    // Sin aviso propio: el evento que lo genera (postulación, invitación) ya avisa por su lado.
    await this.post(tx, conversation, 'SYSTEM', null, input.body, false);
  }

  // ───────────── Soporte ─────────────

  async openReports(query: { cursor?: string; limit?: number }): Promise<MessageReportPageDto> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const rows = await this.prisma.messageReport.findMany({
      where: { resolvedAt: null, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: {
        message: {
          select: {
            id: true,
            side: true,
            bodyEnc: true,
            removedAt: true,
            conversation: {
              select: {
                barbershop: { select: { name: true } },
                user: { select: { fullName: true } },
              },
            },
          },
        },
      },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        messageId: r.messageId,
        reason: r.reason,
        details: r.details,
        messageBody: this.encryption.decrypt(r.message.bodyEnc, EncryptedField.MESSAGE_BODY),
        messageSide: r.message.side,
        barbershopName: r.message.conversation.barbershop.name,
        userName: r.message.conversation.user.fullName,
        removed: r.message.removedAt !== null,
        createdAt: r.createdAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  /** Resuelve todos los reportes abiertos del mensaje; REMOVE además lo retira. */
  async resolveReport(
    staffId: string,
    reportId: string,
    dto: ResolveMessageReportDto,
  ): Promise<void> {
    const report = await this.prisma.messageReport.findUnique({
      where: { id: reportId },
      select: { messageId: true },
    });
    if (!report) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El reporte no existe.', HttpStatus.NOT_FOUND);
    }
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      if (dto.action === 'REMOVE') {
        await tx.message.update({ where: { id: report.messageId }, data: { removedAt: now } });
      }
      await tx.messageReport.updateMany({
        where: { messageId: report.messageId, resolvedAt: null },
        data: { resolvedAt: now, resolvedById: staffId, resolution: dto.action },
      });
      await this.audit.record(
        {
          actorId: staffId,
          action: dto.action === 'REMOVE' ? 'message.removed' : 'message_report.dismissed',
          entityType: 'message',
          entityId: report.messageId,
          changes: { reason: dto.reason },
        },
        tx,
      );
    });
  }

  // ───────────── Internos ─────────────

  private async ensure(
    tx: Prisma.TransactionClient,
    barbershopId: string,
    userId: string,
    kind: ConversationKind,
    rejectBlocked = true,
  ): Promise<{ id: string; barbershopId: string; userId: string; blockedBy: MessageSide | null }> {
    // Idempotente ante dos inicios simultáneos (clave única barbería + persona + tipo).
    await tx.$executeRaw`
      INSERT INTO conversations (id, barbershop_id, user_id, kind, last_message_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${barbershopId}::uuid, ${userId}::uuid, ${kind}::"ConversationKind", now(), now(), now())
      ON CONFLICT (barbershop_id, user_id, kind) DO NOTHING`;
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { barbershopId_userId_kind: { barbershopId, userId, kind } },
      select: { id: true, barbershopId: true, userId: true, blockedBy: true },
    });
    if (rejectBlocked && conversation.blockedBy) throw blocked();
    return conversation;
  }

  private async post(
    tx: Prisma.TransactionClient,
    conversation: { id: string; barbershopId: string; userId: string },
    side: MessageSide,
    senderId: string | null,
    body: string,
    notify = true,
  ): Promise<{ id: string; createdAt: Date }> {
    const now = new Date(this.clock.now());
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        side,
        senderId,
        bodyEnc: this.encryption.encrypt(body, EncryptedField.MESSAGE_BODY),
        createdAt: now,
      },
      select: { id: true, createdAt: true },
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: now,
        // Quien escribe ya leyó la conversación.
        ...(side === 'USER'
          ? { userReadAt: now }
          : side === 'BARBERSHOP'
            ? { barbershopReadAt: now }
            : {}),
      },
    });
    await this.outbox.publish(tx, 'message.sent', {
      messageId: message.id,
      conversationId: conversation.id,
      side,
      notify,
    });
    return message;
  }

  private async markRead(viewer: Viewer, conversationId: string): Promise<void> {
    const now = new Date(this.clock.now());
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: viewer.side === 'USER' ? { userReadAt: now } : { barbershopReadAt: now },
    });
  }

  private async find(viewer: Viewer, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, barbershopId: true, userId: true, blockedBy: true },
    });
    const allowed =
      conversation &&
      (viewer.side === 'USER'
        ? conversation.userId === viewer.userId
        : conversation.barbershopId === viewer.barbershopId);
    if (!allowed) throw notFound();
    return conversation;
  }

  private reload(id: string): Promise<ConversationRow> {
    return this.prisma.conversation.findUniqueOrThrow({
      where: { id },
      include: conversationInclude,
    });
  }

  private async list(
    viewer: Viewer,
    where: Prisma.ConversationWhereInput,
    query: { cursor?: string; limit?: number },
  ): Promise<ConversationPageDto> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    let after: { lastMessageAt: Date; id: string } | null = null;
    if (query.cursor) {
      after = await this.prisma.conversation.findUnique({
        where: { id: query.cursor },
        select: { lastMessageAt: true, id: true },
      });
    }
    const rows = await this.prisma.conversation.findMany({
      where: {
        ...where,
        ...(after
          ? {
              OR: [
                { lastMessageAt: { lt: after.lastMessageAt } },
                { lastMessageAt: after.lastMessageAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: conversationInclude,
    });
    const page = rows.slice(0, limit);
    return {
      items: await this.toConversations(viewer, page),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  private async toConversations(
    viewer: Viewer,
    rows: ConversationRow[],
  ): Promise<ConversationDto[]> {
    const media = await barbershopMedia(
      this.prisma,
      this.storage,
      rows.map((r) => r.barbershopId),
    );
    return Promise.all(
      rows.map(async (r) => {
        const readAt = viewer.side === 'USER' ? r.userReadAt : r.barbershopReadAt;
        const unread = await this.prisma.message.count({
          where: {
            conversationId: r.id,
            side: { not: viewer.side },
            ...(readAt ? { createdAt: { gt: readAt } } : {}),
          },
        });
        const last = r.messages[0];
        const profile =
          r.user.barberProfile && !r.user.barberProfile.deletedAt ? r.user.barberProfile : null;
        const professional = r.kind === 'PROFESSIONAL' && profile;
        return {
          id: r.id,
          kind: r.kind,
          counterpart:
            viewer.side === 'USER'
              ? {
                  id: r.barbershop.id,
                  name: r.barbershop.name,
                  photoUrl: media.get(r.barbershopId)?.logoUrl ?? null,
                  barberProfileId: null,
                }
              : {
                  id: r.user.id,
                  // La barbería ve el usuario y el nombre de pila (para saber a quién atiende).
                  name: professional
                    ? profile.displayName
                    : `${r.user.username} · ${firstName(r.user.fullName) ?? ''}`.trim(),
                  photoUrl: professional
                    ? variantUrl(this.storage, profile.photoVariants, 'square')
                    : variantUrl(this.storage, r.user.photoVariants, 'square'),
                  barberProfileId: profile?.id ?? null,
                },
          lastMessagePreview: last
            ? last.removedAt
              ? REMOVED_TEXT
              : this.encryption
                  .decrypt(last.bodyEnc, EncryptedField.MESSAGE_BODY)
                  .slice(0, PREVIEW_LENGTH)
            : null,
          lastMessageAt: r.lastMessageAt,
          unread,
          blocked: r.blockedBy !== null,
          blockedByMe: r.blockedBy === viewer.side,
        };
      }),
    );
  }
}

function firstName(fullName: string | null): string | null {
  if (!fullName) return null;
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}
