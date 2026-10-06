import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  DEFAULT_PAGE_SIZE,
  type Page,
  type PaginationQueryDto,
  pageArgs,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { TicketStatus } from '../../generated/prisma/enums';
import { ConflictOfInterestService, type StaffActor } from '../admin/admin-access';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import type {
  AssignTicketDto,
  CreateTicketDto,
  RelatedType,
  StaffTicketDetailDto,
  StaffTicketDto,
  StaffTicketMessageInputDto,
  TicketDetailDto,
  TicketQueueQueryDto,
  TicketSummaryDto,
  UpdateTicketStatusDto,
} from './dto/ticket.dto';
import {
  canStaffMoveTicket,
  closingNeedsReason,
  OPEN_TICKET_STATUSES,
  SUPPORT_DEFAULTS,
  userReplyDecision,
} from './support-policy';

const staffInclude = {
  user: { select: { id: true, fullName: true } },
  assignedTo: { select: { id: true, fullName: true } },
} as const;

type TicketRow = Prisma.SupportTicketGetPayload<object>;
type StaffTicketRow = Prisma.SupportTicketGetPayload<{ include: typeof staffInclude }>;

const ticketNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El ticket no existe.', HttpStatus.NOT_FOUND);

const ticketClosed = (): AppException =>
  new AppException(
    ErrorCode.TICKET_CLOSED,
    'Este ticket ya está cerrado. Si necesitas ayuda, abre uno nuevo.',
    HttpStatus.CONFLICT,
  );

/**
 * Tickets de soporte (RF-SOP-001…003). Los mensajes se guardan cifrados
 * (`EncryptedField.TICKET_MESSAGE_BODY`). El usuario nunca ve las notas internas ni quién de
 * soporte respondió. Soporte nunca actúa sobre sus propios tickets ni sobre los de una barbería de
 * la que es miembro (conflicto de interés).
 */
@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly access: BarbershopAccessService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly conflicts: ConflictOfInterestService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Usuario ─────────────

  /** RF-SOP-001. También desde la sesión restringida de una cuenta deshabilitada. */
  async create(userId: string, dto: CreateTicketDto): Promise<TicketDetailDto> {
    if (dto.relatedType && dto.relatedId) {
      await this.assertOwnsRelated(userId, dto.relatedType, dto.relatedId);
    }
    const maxOpen = await this.settings.positiveInt(
      SettingKey.SUPPORT_MAX_OPEN_TICKETS_PER_USER,
      SUPPORT_DEFAULTS.maxOpenTicketsPerUser,
    );
    const ticketId = await this.prisma.$transaction(async (tx) => {
      // Serializa por usuario: el máximo de abiertos no se supera con peticiones simultáneas.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tickets:${userId}`}))`;
      const open = await tx.supportTicket.count({
        where: { userId, status: { in: OPEN_TICKET_STATUSES } },
      });
      if (open >= maxOpen) {
        throw new AppException(
          ErrorCode.TOO_MANY_REQUESTS,
          `Ya tienes ${open} solicitudes abiertas. Espera a que soporte las atienda.`,
          HttpStatus.TOO_MANY_REQUESTS,
          [{ maxOpen }],
        );
      }
      const now = new Date(this.clock.now());
      const ticket = await tx.supportTicket.create({
        data: {
          userId,
          category: dto.category,
          subject: dto.subject,
          relatedType: dto.relatedType ?? null,
          relatedId: dto.relatedType ? dto.relatedId! : null,
          createdAt: now,
        },
        select: { id: true },
      });
      await this.addMessage(tx, ticket.id, userId, dto.message, false);
      return ticket.id;
    });
    return this.getMine(userId, ticketId);
  }

  async listMine(userId: string, query: PaginationQueryDto): Promise<Page<TicketSummaryDto>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await this.prisma.supportTicket.findMany({
      where: { userId, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((t) => this.toSummary(t)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async getMine(userId: string, ticketId: string): Promise<TicketDetailDto> {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
    });
    if (!ticket) throw ticketNotFound();
    const messages = await this.prisma.ticketMessage.findMany({
      where: { ticketId, isInternal: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const reopenDays = await this.reopenDays();
    return {
      ...this.toSummary(ticket),
      messages: messages.map((m) => ({
        id: m.id,
        body: this.decrypt(m.bodyEnc),
        from: m.authorId === ticket.userId ? 'USER' : 'SUPPORT',
        createdAt: m.createdAt.toISOString(),
      })),
      canReply:
        userReplyDecision(ticket.status, ticket.resolvedAt, this.clock.now(), reopenDays) !==
        'REJECT',
    };
  }

  /** Responder: agrega a un abierto; reabre un RESOLVED dentro del plazo; si no, 409. */
  async replyAsUser(userId: string, ticketId: string, body: string): Promise<TicketDetailDto> {
    const reopenDays = await this.reopenDays();
    await this.prisma.$transaction(async (tx) => {
      const ticket = await this.lock(tx, ticketId);
      if (!ticket || ticket.user_id !== userId) throw ticketNotFound();
      const decision = userReplyDecision(
        ticket.status,
        ticket.resolved_at,
        this.clock.now(),
        reopenDays,
      );
      if (decision === 'REJECT') throw ticketClosed();
      await this.addMessage(tx, ticketId, userId, body, false);
      if (decision === 'REOPEN') {
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: { status: 'IN_PROGRESS', resolvedAt: null },
        });
        await this.audit.record(
          {
            actorId: userId,
            action: 'ticket.reopened',
            entityType: 'support_ticket',
            entityId: ticketId,
            changes: { from: 'RESOLVED', to: 'IN_PROGRESS', by: 'USER' },
          },
          tx,
        );
      }
    });
    return this.getMine(userId, ticketId);
  }

  // ───────────── Soporte ─────────────

  /** RF-SOP-002: cola común. Nunca muestra los tickets propios de quien consulta. */
  async queue(staff: StaffActor, query: TicketQueueQueryDto): Promise<Page<StaffTicketDto>> {
    const args = pageArgs(query);
    const rows = await this.prisma.supportTicket.findMany({
      where: {
        ...args.where,
        userId: { not: staff.id },
        status: query.status ?? { in: OPEN_TICKET_STATUSES },
        ...(query.category ? { category: query.category } : {}),
        ...(query.assigned === 'me' ? { assignedToId: staff.id } : {}),
        ...(query.assigned === 'unassigned' ? { assignedToId: null } : {}),
      },
      orderBy: args.orderBy,
      take: args.take,
      include: staffInclude,
    });
    return toPage(rows, query, (t) => this.toStaff(t));
  }

  async getForStaff(staff: StaffActor, ticketId: string): Promise<StaffTicketDetailDto> {
    const ticket = await this.loadForStaff(staff, ticketId);
    const messages = await this.prisma.ticketMessage.findMany({
      where: { ticketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { author: { select: { id: true, fullName: true } } },
    });
    return {
      ...this.toStaff(ticket),
      messages: messages.map((m) => ({
        id: m.id,
        body: this.decrypt(m.bodyEnc),
        from: m.authorId === ticket.userId ? 'USER' : 'SUPPORT',
        isInternal: m.isInternal,
        author: { id: m.author.id, fullName: m.author.fullName },
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /** Tomar (sin `assigneeId`) o reasignar a otra cuenta de soporte o ADMIN. OPEN → IN_PROGRESS. */
  async assign(
    staff: StaffActor,
    ticketId: string,
    dto: AssignTicketDto,
  ): Promise<StaffTicketDetailDto> {
    await this.loadForStaff(staff, ticketId);
    const assigneeId = dto.assigneeId ?? staff.id;
    if (assigneeId !== staff.id) {
      const assignee = await this.users.findCredentialsById(assigneeId);
      const isStaff =
        assignee &&
        !assignee.isDeleted &&
        assignee.status === 'ACTIVE' &&
        assignee.roles.some((r) => r === 'SUPPORT' || r === 'ADMIN');
      if (!isStaff) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Solo se puede asignar a una cuenta de soporte activa.',
          HttpStatus.BAD_REQUEST,
          [{ field: 'assigneeId', constraints: ['supportAccount'] }],
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const ticket = await this.lock(tx, ticketId);
      if (!ticket) throw ticketNotFound();
      if (ticket.status === 'CLOSED') throw ticketClosed();
      if (ticket.user_id === assigneeId) {
        throw new AppException(
          ErrorCode.CONFLICT_OF_INTEREST,
          'No se puede asignar un ticket a quien lo abrió.',
          HttpStatus.FORBIDDEN,
        );
      }
      const status: TicketStatus = ticket.status === 'OPEN' ? 'IN_PROGRESS' : ticket.status;
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { assignedToId: assigneeId, status },
      });
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'ticket.assigned',
          entityType: 'support_ticket',
          entityId: ticketId,
          changes: {
            assignedTo: { from: ticket.assigned_to, to: assigneeId },
            status: { from: ticket.status, to: status },
            actorRole: staff.role,
          },
        },
        tx,
      );
    });
    return this.getForStaff(staff, ticketId);
  }

  /**
   * Respuesta de soporte. Una respuesta visible a un OPEN lo pasa a IN_PROGRESS y, si no tenía
   * responsable, lo toma quien responde. Una nota interna no cambia nada.
   */
  async replyAsStaff(
    staff: StaffActor,
    ticketId: string,
    dto: StaffTicketMessageInputDto,
  ): Promise<StaffTicketDetailDto> {
    await this.loadForStaff(staff, ticketId);
    await this.prisma.$transaction(async (tx) => {
      const ticket = await this.lock(tx, ticketId);
      if (!ticket) throw ticketNotFound();
      if (ticket.status === 'CLOSED') throw ticketClosed();
      const internal = dto.isInternal ?? false;
      await this.addMessage(tx, ticketId, staff.id, dto.body, internal);
      if (!internal && ticket.status === 'OPEN') {
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: { status: 'IN_PROGRESS', assignedToId: ticket.assigned_to ?? staff.id },
        });
      }
    });
    return this.getForStaff(staff, ticketId);
  }

  async setStatus(
    staff: StaffActor,
    ticketId: string,
    dto: UpdateTicketStatusDto,
  ): Promise<StaffTicketDetailDto> {
    await this.loadForStaff(staff, ticketId);
    await this.prisma.$transaction(async (tx) => {
      const ticket = await this.lock(tx, ticketId);
      if (!ticket) throw ticketNotFound();
      if (!canStaffMoveTicket(ticket.status, dto.status)) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Ese cambio de estado no está permitido.',
          HttpStatus.CONFLICT,
          [{ from: ticket.status, to: dto.status }],
        );
      }
      if (closingNeedsReason(ticket.status, dto.status) && !dto.reason) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Indica el motivo para cerrar un ticket sin resolver.',
          HttpStatus.BAD_REQUEST,
          [{ field: 'reason', constraints: ['requiredToClose'] }],
        );
      }
      const now = new Date(this.clock.now());
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: dto.status,
          ...(dto.status === 'RESOLVED' ? { resolvedAt: now } : {}),
          ...(dto.status === 'IN_PROGRESS' ? { resolvedAt: null } : {}),
          ...(dto.status === 'CLOSED' ? { closedAt: now } : {}),
          ...(ticket.assigned_to ? {} : { assignedToId: staff.id }),
        },
      });
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'ticket.status_changed',
          entityType: 'support_ticket',
          entityId: ticketId,
          changes: {
            status: { from: ticket.status, to: dto.status },
            reason: dto.reason ?? null,
            actorRole: staff.role,
          },
        },
        tx,
      );
    });
    return this.getForStaff(staff, ticketId);
  }

  /** Cierre automático: RESOLVED sin respuesta del usuario durante `ticket_auto_close_days`. */
  async autoCloseResolved(): Promise<number> {
    const days = await this.settings.positiveInt(
      SettingKey.SUPPORT_TICKET_AUTO_CLOSE_DAYS,
      SUPPORT_DEFAULTS.autoCloseDays,
    );
    const now = this.clock.now();
    const cutoff = new Date(now - days * 24 * 3600_000);
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM support_tickets
         WHERE status = 'RESOLVED' AND resolved_at < ${cutoff}
         ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED`;
      if (due.length === 0) return 0;
      const ids = due.map((d) => d.id);
      await tx.supportTicket.updateMany({
        where: { id: { in: ids } },
        data: { status: 'CLOSED', closedAt: new Date(now) },
      });
      await tx.auditLog.createMany({
        data: ids.map((id) => ({
          action: 'ticket.auto_closed',
          entityType: 'support_ticket',
          entityId: id,
          changes: { from: 'RESOLVED', to: 'CLOSED', afterDays: days },
        })),
      });
      this.logger.log({ count: ids.length }, 'Tickets resueltos cerrados automáticamente');
      return ids.length;
    });
  }

  // ───────────── Auxiliares ─────────────

  private reopenDays(): Promise<number> {
    return this.settings.positiveInt(
      SettingKey.SUPPORT_TICKET_REOPEN_DAYS,
      SUPPORT_DEFAULTS.reopenDays,
    );
  }

  private async lock(
    tx: Prisma.TransactionClient,
    ticketId: string,
  ): Promise<
    | {
        user_id: string;
        status: TicketStatus;
        assigned_to: string | null;
        resolved_at: Date | null;
      }
    | undefined
  > {
    const [row] = await tx.$queryRaw<
      {
        user_id: string;
        status: TicketStatus;
        assigned_to: string | null;
        resolved_at: Date | null;
      }[]
    >`SELECT user_id::text AS user_id, status, assigned_to::text AS assigned_to, resolved_at
        FROM support_tickets WHERE id = ${ticketId}::uuid FOR UPDATE`;
    return row;
  }

  private async addMessage(
    tx: Prisma.TransactionClient,
    ticketId: string,
    authorId: string,
    body: string,
    isInternal: boolean,
  ): Promise<void> {
    await tx.ticketMessage.create({
      data: {
        ticketId,
        authorId,
        isInternal,
        bodyEnc: this.encryption.encrypt(body, EncryptedField.TICKET_MESSAGE_BODY),
        createdAt: new Date(this.clock.now()),
      },
    });
    await tx.supportTicket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } });
  }

  private decrypt(bodyEnc: string): string {
    return this.encryption.decrypt(bodyEnc, EncryptedField.TICKET_MESSAGE_BODY);
  }

  /** Carga el ticket y aplica el conflicto de interés (propio, o de una barbería propia). */
  private async loadForStaff(staff: StaffActor, ticketId: string): Promise<StaffTicketRow> {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: staffInclude,
    });
    if (!ticket) throw ticketNotFound();
    this.conflicts.assertNotSelf(staff, ticket.userId);
    const barbershopId = await this.relatedBarbershop(ticket.relatedType, ticket.relatedId);
    if (barbershopId) await this.conflicts.assertNotMember(staff, barbershopId);
    return ticket;
  }

  private async relatedBarbershop(type: string | null, id: string | null): Promise<string | null> {
    if (!type || !id) return null;
    if (type === 'barbershop') return id;
    if (type === 'booking') {
      return (
        (await this.prisma.booking.findUnique({ where: { id }, select: { barbershopId: true } }))
          ?.barbershopId ?? null
      );
    }
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      select: { booking: { select: { barbershopId: true } } },
    });
    return payment?.booking.barbershopId ?? null;
  }

  /** La relación debe ser propia: su reserva o pago (como cliente o barbería) o su barbería. */
  private async assertOwnsRelated(userId: string, type: RelatedType, id: string): Promise<void> {
    let owned: boolean;
    if (type === 'barbershop') {
      owned = await this.access.isMember(id, userId);
    } else {
      const booking =
        type === 'booking'
          ? await this.prisma.booking.findUnique({
              where: { id },
              select: { clientId: true, barbershopId: true },
            })
          : (
              await this.prisma.payment.findUnique({
                where: { id },
                select: { booking: { select: { clientId: true, barbershopId: true } } },
              })
            )?.booking;
      owned =
        !!booking &&
        (booking.clientId === userId || (await this.access.isMember(booking.barbershopId, userId)));
    }
    if (!owned) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No encontramos esa reserva, pago o barbería entre los tuyos.',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private toSummary(t: TicketRow): TicketSummaryDto {
    return {
      id: t.id,
      category: t.category,
      subject: t.subject,
      status: t.status,
      related:
        t.relatedType && t.relatedId
          ? { type: t.relatedType as RelatedType, id: t.relatedId }
          : null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      closedAt: t.closedAt?.toISOString() ?? null,
    };
  }

  private toStaff(t: StaffTicketRow): StaffTicketDto {
    return {
      ...this.toSummary(t),
      requester: { id: t.user.id, fullName: t.user.fullName },
      assignedTo: t.assignedTo ? { id: t.assignedTo.id, fullName: t.assignedTo.fullName } : null,
    };
  }
}
