import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { PasswordHasher } from '../../common/crypto/password-hasher';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MAILER, type Mailer } from '../../common/mail/mailer';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { SessionsService } from '../auth/sessions.service';
import { BookingsService } from '../bookings/bookings.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { ANONYMIZED_NAME, UsersService } from '../users/users.service';
import { variantKeys } from '../images/image-variants';
import { ImagesService } from '../images/images.service';
import type {
  AccountDeletionPreviewDto,
  AccountDeletionStatusDto,
  DeletionBlockerDto,
} from './dto/account-deletion.dto';

export const ACCOUNT_DELETION_DEFAULTS = { graceDays: 30, emailBlockDays: 365 } as const;
const REMIND_BEFORE_MS = 3 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export const DELETION_EVENTS = {
  REQUESTED: 'user.deletion_requested',
  REMINDER: 'user.deletion_reminder',
  CANCELLED: 'user.deletion_cancelled',
  DELETED: 'user.deleted',
} as const;

/**
 * Eliminación de cuenta (exigida por Apple y Google).
 * 1. **Solicitud** (contraseña): cancela sus reservas activas como cancelación del cliente (misma
 *    política de devolución), cierra sus tickets y sus sesiones, y la programa para dentro de
 *    `account_deletion.grace_days` (30). Durante el plazo solo puede consultarla o cancelarla.
 * 2. **Cancelación** dentro del plazo: la cuenta vuelve; las reservas canceladas no se restauran.
 * 3. **Ejecución** al vencer (trabajo programado): borra o anonimiza todos sus datos personales en
 *    una transacción. Se conservan, anonimizados, pagos, reembolsos, reservas, auditoría y la
 *    puntuación de sus valoraciones (sin el comentario).
 * Bloqueos: único OWNER de una barbería activa, o roles de soporte o ADMIN.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly bookings: BookingsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly images: ImagesService,
  ) {}

  // ───────────── Consulta ─────────────

  async preview(userId: string): Promise<AccountDeletionPreviewDto> {
    const graceDays = await this.graceDays();
    const [blockers, bookings, status] = await Promise.all([
      this.blockers(userId),
      this.bookings.previewForAccountDeletion(userId),
      this.status(userId),
    ]);
    return {
      canRequest: blockers.length === 0 && !status.pending,
      blockers,
      bookings,
      graceDays,
      scheduledForIfRequestedNow: new Date(this.clock.now() + graceDays * DAY_MS),
      pending: status.pending,
    };
  }

  async status(userId: string): Promise<AccountDeletionStatusDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { deletionRequestedAt: true, deletionScheduledFor: true },
    });
    return {
      pending: user.deletionScheduledFor !== null,
      requestedAt: user.deletionRequestedAt,
      scheduledFor: user.deletionScheduledFor,
    };
  }

  // ───────────── Solicitud y cancelación ─────────────

  async request(
    userId: string,
    currentSessionId: string,
    password: string,
    ip: string | null,
  ): Promise<AccountDeletionStatusDto> {
    const credentials = await this.users.findCredentialsById(userId);
    if (
      !credentials ||
      credentials.isDeleted ||
      !(await PasswordHasher.verify(credentials.passwordHash, password))
    ) {
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'La contraseña no es correcta.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (credentials.pendingDeletion) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'La eliminación de tu cuenta ya está programada.',
        HttpStatus.CONFLICT,
      );
    }
    const blockers = await this.blockers(userId);
    if (blockers.length > 0) {
      throw new AppException(
        ErrorCode.DELETION_BLOCKED,
        'Antes de eliminar tu cuenta resuelve lo indicado.',
        HttpStatus.CONFLICT,
        blockers,
      );
    }
    const graceDays = await this.graceDays();
    const now = new Date(this.clock.now());
    const scheduledFor = new Date(now.getTime() + graceDays * DAY_MS);

    const { revoked, cancelled } = await this.prisma.$transaction(
      async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: {
            deletionRequestedAt: now,
            deletionScheduledFor: scheduledFor,
            deletionRemindedAt: null,
          },
        });
        const cancelledIds = await this.bookings.cancelForAccountDeletionInTx(tx, userId);
        await tx.supportTicket.updateMany({
          where: { userId, status: { not: 'CLOSED' } },
          data: { status: 'CLOSED', closedAt: now },
        });
        const sessionIds = await this.sessions.revokeAllForUser(userId, tx);
        await this.outbox.publish(tx, DELETION_EVENTS.REQUESTED, { userId });
        await this.audit.record(
          {
            actorId: userId,
            action: 'account.deletion_requested',
            entityType: 'user',
            entityId: userId,
            ip,
            changes: { scheduledFor: scheduledFor.toISOString(), cancelledBookings: cancelledIds },
          },
          tx,
        );
        return { revoked: sessionIds, cancelled: cancelledIds };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    await this.sessions.markRevoked([...revoked, currentSessionId]);
    this.logger.log({ cancelledBookings: cancelled.length }, 'Eliminación de cuenta programada');
    return { pending: true, requestedAt: now, scheduledFor };
  }

  /** Dentro del plazo. Las reservas canceladas al solicitar no se restauran. */
  async cancel(userId: string, ip: string | null): Promise<AccountDeletionStatusDto> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: userId, deletionScheduledFor: { not: null }, anonymizedAt: null },
        data: { deletionRequestedAt: null, deletionScheduledFor: null, deletionRemindedAt: null },
      });
      if (count === 0) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'No hay una eliminación de cuenta pendiente.',
          HttpStatus.CONFLICT,
        );
      }
      await this.outbox.publish(tx, DELETION_EVENTS.CANCELLED, { userId });
      await this.audit.record(
        {
          actorId: userId,
          action: 'account.deletion_cancelled',
          entityType: 'user',
          entityId: userId,
          ip,
          changes: {},
        },
        tx,
      );
    });
    return { pending: false, requestedAt: null, scheduledFor: null };
  }

  // ───────────── Trabajos programados ─────────────

  /** Recordatorio 3 días antes de la ejecución (una vez). */
  async sendReminders(): Promise<number> {
    const now = this.clock.now();
    const due = await this.prisma.user.findMany({
      where: {
        anonymizedAt: null,
        deletionRemindedAt: null,
        deletionScheduledFor: { not: null, lte: new Date(now + REMIND_BEFORE_MS) },
      },
      select: { id: true },
      take: 500,
    });
    for (const { id } of due) {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.user.updateMany({
          where: { id, deletionRemindedAt: null, deletionScheduledFor: { not: null } },
          data: { deletionRemindedAt: new Date(now) },
        });
        if (count > 0) await this.outbox.publish(tx, DELETION_EVENTS.REMINDER, { userId: id });
      });
    }
    return due.length;
  }

  /** Ejecuta las eliminaciones vencidas. Una transacción por cuenta. */
  async executeDue(limit = 50): Promise<number> {
    const due = await this.prisma.user.findMany({
      where: {
        anonymizedAt: null,
        deletionScheduledFor: { not: null, lte: new Date(this.clock.now()) },
      },
      select: { id: true },
      orderBy: { deletionScheduledFor: 'asc' },
      take: limit,
    });
    let done = 0;
    for (const { id } of due) {
      if (await this.execute(id)) done++;
    }
    return done;
  }

  private async execute(userId: string): Promise<boolean> {
    // Si durante el plazo pasó a ser único OWNER o tomó un rol de soporte, no se ejecuta.
    const blockers = await this.blockers(userId);
    if (blockers.length > 0) {
      this.logger.warn({ userId }, 'Eliminación de cuenta bloqueada al ejecutarse');
      return false;
    }
    await this.sendFinalNotice(userId);
    const blockDays = await this.settings.positiveInt(
      SettingKey.ACCOUNT_DELETION_EMAIL_BLOCK_DAYS,
      ACCOUNT_DELETION_DEFAULTS.emailBlockDays,
    );
    const now = new Date(this.clock.now());
    let imageKeys: string[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        const [user] = await tx.$queryRaw<
          { status: string; email_hash: Buffer; anonymized: boolean }[]
        >`
        SELECT status::text AS status, email_hash, anonymized_at IS NOT NULL AS anonymized
          FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        if (!user || user.anonymized) return;
        // Deshabilitada por soporte: su correo no se puede registrar de nuevo durante un tiempo.
        if (user.status === 'DISABLED') {
          await tx.emailBlocklist.upsert({
            where: { emailHash: Buffer.from(user.email_hash) },
            update: { blockedUntil: new Date(now.getTime() + blockDays * DAY_MS) },
            create: {
              emailHash: Buffer.from(user.email_hash),
              blockedUntil: new Date(now.getTime() + blockDays * DAY_MS),
            },
          });
        }
        // La foto de perfil del barbero es un dato personal: se borra. La galería es de la barbería.
        const barbers = await tx.barber.findMany({ where: { userId }, select: { id: true } });
        imageKeys = await this.images.softDeleteInTx(tx, {
          barberIds: barbers.map((b) => b.id),
          kinds: ['BARBER_PHOTO'],
        });
        // Carrera del barbero: el perfil profesional se anonimiza; su foto y los cortes que subió
        // desde su perfil se borran (los subidos en una barbería quedan sin perfil público).
        const profile = await tx.barberProfile.findUnique({
          where: { userId },
          select: { id: true, photoVariants: true },
        });
        if (profile) {
          imageKeys = [...imageKeys, ...variantKeys(profile.photoVariants)];
          const own = await tx.image.findMany({
            where: { barberProfileId: profile.id, barbershopId: null, deletedAt: null },
            select: { id: true, variants: true },
          });
          await tx.image.updateMany({
            where: { id: { in: own.map((i) => i.id) } },
            data: { deletedAt: now },
          });
          imageKeys = [...imageKeys, ...own.flatMap((i) => variantKeys(i.variants))];
          await tx.barberProfile.update({
            where: { id: profile.id },
            data: {
              displayName: ANONYMIZED_NAME,
              headline: null,
              bio: null,
              district: null,
              availableForWork: false,
              photoVariants: Prisma.DbNull,
              deletedAt: now,
            },
          });
        }
        await this.eraseRelated(tx, userId);
        imageKeys = [...imageKeys, ...(await this.users.anonymize(userId, now, tx))];
        await this.outbox.publish(tx, DELETION_EVENTS.DELETED, { userId });
        await this.audit.record(
          {
            actorId: null,
            action: 'account.deleted',
            entityType: 'user',
            entityId: userId,
            changes: { emailBlocked: user.status === 'DISABLED' },
          },
          tx,
        );
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    // Archivos: después de confirmar (regla 12).
    await this.images.deleteFiles(imageKeys);
    return true;
  }

  /**
   * Borra o anonimiza lo que la cuenta dejó en otras tablas. Se conservan (sin datos personales)
   * reservas, pagos, reembolsos, historial, auditoría y la puntuación de sus valoraciones.
   */
  private async eraseRelated(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.userMfa.deleteMany({ where: { userId } });
    await tx.passwordResetToken.deleteMany({ where: { userId } });
    await tx.emailVerificationCode.deleteMany({ where: { userId } });
    await tx.deviceToken.deleteMany({ where: { userId } });
    await tx.favorite.deleteMany({ where: { clientId: userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.barbershopInvitation.deleteMany({ where: { invitedUserId: userId } });
    await tx.barbershopMember.deleteMany({ where: { userId } });
    await tx.barber.updateMany({ where: { userId }, data: { userId: null } });
    // Tickets: cerrados al solicitar; ahora se borran sus mensajes y su asunto.
    const tickets = await tx.supportTicket.findMany({ where: { userId }, select: { id: true } });
    await tx.ticketMessage.deleteMany({ where: { ticketId: { in: tickets.map((t) => t.id) } } });
    await tx.ticketMessage.deleteMany({ where: { authorId: userId } });
    await tx.supportTicket.updateMany({
      where: { userId },
      data: { subject: 'Solicitud eliminada', status: 'CLOSED', metadata: {} },
    });
    // Valoraciones: queda la puntuación (los promedios no cambian); se borra el comentario.
    await tx.review.updateMany({ where: { clientId: userId }, data: { comment: null } });
    await tx.reviewReport.updateMany({ where: { reportedById: userId }, data: { details: null } });
    await tx.barbershopReport.updateMany({
      where: { reportedById: userId },
      data: { details: null },
    });
    await tx.imageReport.updateMany({ where: { reportedById: userId }, data: { details: null } });
    // Motivos que escribió al cancelar sus reservas.
    await tx.booking.updateMany({
      where: { clientId: userId, cancelledById: userId },
      data: { cancelReason: null },
    });
    // La auditoría se conserva; su IP es un dato personal. Única excepción a "solo inserción",
    // por la función de la base que solo puede poner la IP en NULL.
    await tx.$queryRaw`SELECT audit_log_redact_ip(${userId}::uuid)`;
    // El mismo motivo quedó copiado en el historial: se conservan la transición y la fecha.
    await tx.bookingStatusHistory.updateMany({
      where: { changedById: userId, reason: { not: null } },
      data: { reason: null },
    });
  }

  /** Último correo antes de borrar la dirección (fuera de la transacción; una sola vez). */
  private async sendFinalNotice(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deletionFinalNoticeAt: true },
    });
    if (!user || user.deletionFinalNoticeAt) return;
    const to = await this.users.contactEmail(userId);
    if (to) {
      await this.mailer.send({
        to,
        subject: 'Tu cuenta de Charles fue eliminada',
        text:
          'Eliminamos tu cuenta de Charles como pediste. Tus datos personales se borraron; ' +
          'conservamos solo lo que la ley exige (pagos y reservas), sin datos que te identifiquen.',
        category: 'account-deleted',
      });
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { deletionFinalNoticeAt: new Date(this.clock.now()) },
    });
  }

  // ───────────── Auxiliares ─────────────

  /** Lo que impide eliminar la cuenta ahora. */
  async blockers(userId: string): Promise<DeletionBlockerDto[]> {
    const credentials = await this.users.findCredentialsById(userId);
    const blockers: DeletionBlockerDto[] = [];
    if (credentials?.roles.some((r) => r === 'SUPPORT' || r === 'ADMIN')) {
      blockers.push({ reason: 'STAFF_ROLE', barbershopId: null, barbershopName: null });
    }
    const soleOwned = await this.prisma.$queryRaw<{ id: string; name: string }[]>`
      SELECT b.id::text AS id, b.name
        FROM barbershop_members m
        JOIN barbershops b ON b.id = m.barbershop_id AND b.deleted_at IS NULL
       WHERE m.user_id = ${userId}::uuid AND m.role = 'OWNER'
         AND NOT EXISTS (
           SELECT 1 FROM barbershop_members o
            WHERE o.barbershop_id = m.barbershop_id AND o.role = 'OWNER' AND o.user_id <> m.user_id
         )
       ORDER BY b.id`;
    for (const shop of soleOwned) {
      blockers.push({ reason: 'SOLE_OWNER', barbershopId: shop.id, barbershopName: shop.name });
    }
    return blockers;
  }

  private graceDays(): Promise<number> {
    return this.settings.positiveInt(
      SettingKey.ACCOUNT_DELETION_GRACE_DAYS,
      ACCOUNT_DELETION_DEFAULTS.graceDays,
    );
  }
}
