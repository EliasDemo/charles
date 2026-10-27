import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MAILER, type Mailer } from '../../common/mail/mailer';
import { IdempotentConsumerStore } from '../../common/outbox/idempotent-consumer';
import { OutboxDispatcher } from '../../common/outbox/outbox.dispatcher';
import type { OutboxMessage } from '../../common/outbox/outbox.service';
import { DEFAULT_PAGE_SIZE, type Page } from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { NotificationChannel } from '../../generated/prisma/enums';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { DevicesService } from './devices.service';
import type { NotificationDto, NotificationQueryDto } from './dto/notification.dto';
import {
  type BookingContext,
  planAccountDeletion,
  planApplicationUpdate,
  planCommunityComment,
  planCommunityLike,
  planCommunityMention,
  planCommunityNewPost,
  planCommunityReply,
  planJobOfferAnswered,
  planWaitlistSlotFreed,
  planForumReply,
  planForumSolution,
  planJobOfferReceived,
  planMembershipNotice,
  planSubscriptionNotice,
  planJobApplication,
  planNewMessage,
  planAccountDisabled,
  planBarbershopReview,
  planBarbershopSuspended,
  planBookingEvent,
  planNewReview,
  type PlannedNotification,
  planRefund,
  planReminder,
  planSupportReply,
} from './notification-catalog';
import {
  isValidHhMm,
  NOTIFICATION_DEFAULTS,
  nextAllowedAt,
  normalizeReminderHours,
  type QuietHours,
  reminderDue,
} from './notification-schedule';
import { DEVICE_NOT_REGISTERED, PUSH_SENDER, type PushSender } from './push-sender';

export const NOTIFICATIONS_CONSUMER = 'notifications.dispatcher';
export const NOTIFICATION_EVENTS = [
  'booking.confirmed',
  'booking.cancelled',
  'booking.expired',
  'booking.no_show',
  'refund.succeeded',
  'refund.failed',
  'review.created',
  'ticket.replied',
  'user.disabled',
  'barbershop.suspended',
  'user.deletion_requested',
  'user.deletion_reminder',
  'user.deletion_cancelled',
  'barbershop.review_approved',
  'barbershop.review_changes_requested',
  'message.sent',
  'job.application_created',
  'job.application_updated',
  'billing.subscription',
  'billing.membership',
  'job.offer_created',
  'job.offer_answered',
  'community.post_created',
  'community.commented',
  'community.liked',
  'waitlist.slot_freed',
  'forum.replied',
  'forum.solved',
] as const;

/** Avisos que recibe una cuenta aunque no esté activa (seguridad de la propia cuenta). */
const ACCOUNT_LEVEL_TYPES = new Set([
  'ACCOUNT_DISABLED',
  'ACCOUNT_DELETION_REQUESTED',
  'ACCOUNT_DELETION_REMINDER',
  'ACCOUNT_DELETION_CANCELLED',
]);

const DEFAULT_TIMEZONE = 'America/Lima';
const MAX_ATTEMPTS = 5;
const CLAIM_TIMEOUT_MS = 5 * 60_000;
const RECEIPTS_AFTER_MS = 15 * 60_000;
const CHANNELS: NotificationChannel[] = ['PUSH', 'IN_APP', 'EMAIL'];

interface Recipient {
  status: string;
  deleted: boolean;
  channels: Set<NotificationChannel>;
  reminders: boolean;
}

/**
 * Notificaciones (Fase 10, RF-NOT-001…004).
 * 1. Un consumidor idempotente del outbox convierte cada evento en avisos (catálogo puro) y los
 *    guarda en `notifications`, uno por persona y canal (`dedupe_key` único). La bandeja nace
 *    enviada; push y correo quedan PENDING.
 * 2. La entrega corre aparte, **fuera de toda transacción**: reclama un lote, llama al proveedor y
 *    registra el resultado. Reintenta con espera creciente (5 intentos).
 * 3. Preferencias por canal y de recordatorios; seguridad y pagos se envían siempre.
 * 4. Horario silencioso para los push no urgentes; los recordatorios se adelantan.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly devices: DevicesService,
    private readonly settings: SettingsService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly store: IdempotentConsumerStore,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register({
      name: NOTIFICATIONS_CONSUMER,
      types: NOTIFICATION_EVENTS,
      handle: async (message) => {
        await this.store.runOnce(NOTIFICATIONS_CONSUMER, message.id, () => this.onEvent(message));
      },
    });
  }

  // ───────────── Eventos → avisos ─────────────

  async onEvent(message: OutboxMessage): Promise<void> {
    const plans = await this.plan(message);
    if (plans.length === 0) return;
    const timezone = await this.timezoneOf(message);
    await this.persist(plans, message.id, timezone);
  }

  private async plan(message: OutboxMessage): Promise<PlannedNotification[]> {
    const p = message.payload;
    const id = (key: string) => (typeof p[key] === 'string' ? p[key] : null);
    const now = this.clock.now();
    if (message.type.startsWith('booking.')) {
      const bookingId = id('bookingId');
      const ctx = bookingId ? await this.bookingContext(bookingId) : null;
      if (!ctx) return [];
      return planBookingEvent(
        { status: String(p.status), from: id('from'), actorRole: id('actorRole') },
        ctx,
        now,
      );
    }
    switch (message.type) {
      case 'refund.succeeded':
      case 'refund.failed': {
        const refund = await this.prisma.refund.findUnique({
          where: { id: id('refundId') ?? '' },
          select: {
            amount: true,
            payment: {
              select: { currency: true, booking: { select: { id: true, clientId: true } } },
            },
          },
        });
        if (!refund) return [];
        return [
          planRefund({
            outcome: message.type === 'refund.succeeded' ? 'SUCCEEDED' : 'FAILED',
            clientId: refund.payment.booking.clientId,
            bookingId: refund.payment.booking.id,
            amount: refund.amount,
            currency: refund.payment.currency,
          }),
        ];
      }
      case 'review.created': {
        const barbershopId = id('barbershopId');
        const reviewId = id('reviewId');
        if (!barbershopId || !reviewId) return [];
        return planNewReview({
          staffIds: await this.staffOf(barbershopId),
          reviewId,
          rating: Number(p.rating),
        });
      }
      case 'ticket.replied': {
        const ticket = await this.prisma.supportTicket.findUnique({
          where: { id: id('ticketId') ?? '' },
          select: { id: true, userId: true, subject: true },
        });
        return ticket
          ? [
              planSupportReply({
                userId: ticket.userId,
                ticketId: ticket.id,
                subject: ticket.subject,
              }),
            ]
          : [];
      }
      case 'user.deletion_requested':
      case 'user.deletion_reminder':
      case 'user.deletion_cancelled': {
        const userId = id('userId');
        const user = userId
          ? await this.prisma.user.findUnique({
              where: { id: userId },
              select: { deletionScheduledFor: true },
            })
          : null;
        if (!userId || !user) return [];
        const kind =
          message.type === 'user.deletion_cancelled'
            ? 'CANCELLED'
            : message.type === 'user.deletion_reminder'
              ? 'REMINDER'
              : 'REQUESTED';
        // Un recordatorio de una eliminación ya cancelada no se envía.
        if (kind !== 'CANCELLED' && !user.deletionScheduledFor) return [];
        return [
          planAccountDeletion({
            userId,
            kind,
            scheduledFor: user.deletionScheduledFor?.getTime() ?? null,
          }),
        ];
      }
      case 'user.disabled': {
        const userId = id('userId');
        return userId ? [planAccountDisabled(userId)] : [];
      }
      case 'barbershop.review_approved':
      case 'barbershop.review_changes_requested': {
        const barbershopId = id('barbershopId');
        const shop = barbershopId
          ? await this.prisma.barbershop.findUnique({
              where: { id: barbershopId },
              select: { id: true, name: true, reviewNotes: true },
            })
          : null;
        if (!shop) return [];
        return planBarbershopReview({
          staffIds: await this.staffOf(shop.id),
          barbershopId: shop.id,
          barbershopName: shop.name,
          outcome: message.type === 'barbershop.review_approved' ? 'APPROVED' : 'CHANGES_REQUESTED',
          reason: shop.reviewNotes,
        });
      }
      case 'waitlist.slot_freed': {
        const entry = await this.prisma.waitlistEntry.findUnique({
          where: { id: id('entryId') ?? '' },
          select: {
            userId: true,
            barbershopId: true,
            barbershop: { select: { name: true, timezone: true } },
            service: { select: { name: true } },
          },
        });
        const startAt = id('startAt');
        if (!entry || !startAt) return [];
        return planWaitlistSlotFreed({
          userId: entry.userId,
          barbershopId: entry.barbershopId,
          barbershopName: entry.barbershop.name,
          serviceName: entry.service.name,
          startAt: new Date(startAt),
          timezone: entry.barbershop.timezone,
        });
      }
      case 'community.post_created': {
        const post = await this.prisma.post.findUnique({
          where: { id: id('postId') ?? '' },
          select: {
            id: true,
            type: true,
            createdById: true,
            barbershopId: true,
            authorProfileId: true,
            deletedAt: true,
            removedAt: true,
            barbershop: { select: { name: true } },
            authorProfile: { select: { displayName: true } },
          },
        });
        if (!post || post.deletedAt || post.removedAt) return [];
        const [followers, blocks] = await Promise.all([
          this.prisma.follow.findMany({
            where: post.barbershopId
              ? { barbershopId: post.barbershopId }
              : { barberProfileId: post.authorProfileId },
            select: { followerId: true },
            take: 1000,
          }),
          this.prisma.userBlock.findMany({
            where: { OR: [{ blockerId: post.createdById }, { blockedId: post.createdById }] },
            select: { blockerId: true, blockedId: true },
          }),
        ]);
        const excluded = new Set([
          post.createdById,
          ...blocks.flatMap((b) => [b.blockerId, b.blockedId]),
        ]);
        return planCommunityNewPost({
          userIds: followers.map((f) => f.followerId).filter((u) => !excluded.has(u)),
          postId: post.id,
          authorName: post.barbershop?.name ?? post.authorProfile?.displayName ?? 'Charles',
          type: post.type,
        });
      }
      case 'forum.replied': {
        const reply = await this.prisma.forumReply.findUnique({
          where: { id: id('replyId') ?? '' },
          select: {
            authorId: true,
            body: true,
            author: { select: { username: true } },
            thread: { select: { id: true, authorId: true, title: true } },
          },
        });
        if (!reply || reply.thread.authorId === reply.authorId) return [];
        if ((await this.blockedWith(reply.authorId)).has(reply.thread.authorId)) return [];
        return planForumReply({
          userId: reply.thread.authorId,
          threadId: reply.thread.id,
          title: reply.thread.title,
          author: reply.author.username,
          body: reply.body,
        });
      }
      case 'forum.solved': {
        const reply = await this.prisma.forumReply.findUnique({
          where: { id: id('replyId') ?? '' },
          select: { authorId: true, thread: { select: { id: true, title: true } } },
        });
        if (!reply) return [];
        return planForumSolution({
          userId: reply.authorId,
          threadId: reply.thread.id,
          title: reply.thread.title,
        });
      }
      case 'community.commented': {
        const comment = await this.prisma.postComment.findUnique({
          where: { id: id('commentId') ?? '' },
          select: {
            authorId: true,
            body: true,
            mentionUserId: true,
            author: { select: { username: true } },
            parent: { select: { authorId: true } },
            post: {
              select: { id: true, createdById: true, barbershopId: true, authorProfileId: true },
            },
          },
        });
        if (!comment) return [];
        const blocked = await this.blockedWith(comment.authorId);
        const owners = await this.postOwners(comment.post);
        const base = {
          postId: comment.post.id,
          author: comment.author.username,
          body: comment.body,
        };
        const notified = new Set<string>([comment.authorId]);
        const plans: PlannedNotification[] = [];
        const add = (ids: string[], make: (ids: string[]) => PlannedNotification[]) => {
          const fresh = ids.filter((u) => !notified.has(u) && !blocked.has(u));
          for (const u of fresh) notified.add(u);
          if (fresh.length) plans.push(...make(fresh));
        };
        if (comment.mentionUserId) {
          add([comment.mentionUserId], ([u]) => planCommunityMention({ ...base, userId: u! }));
        }
        if (comment.parent) {
          add([comment.parent.authorId], ([u]) => planCommunityReply({ ...base, userId: u! }));
        }
        add(owners, (ids) => planCommunityComment({ ...base, userIds: ids }));
        return plans;
      }
      case 'community.liked': {
        const likerId = id('userId');
        const commentId = id('commentId');
        const target = commentId
          ? await this.prisma.postComment.findUnique({
              where: { id: commentId },
              select: { authorId: true, likeCount: true, post: { select: { id: true } } },
            })
          : null;
        const post = await this.prisma.post.findUnique({
          where: { id: target?.post.id ?? id('postId') ?? '' },
          select: {
            id: true,
            createdById: true,
            barbershopId: true,
            authorProfileId: true,
            likeCount: true,
          },
        });
        if (!post || !likerId) return [];
        const liker = await this.prisma.user.findUnique({
          where: { id: likerId },
          select: { username: true },
        });
        if (!liker) return [];
        const blocked = await this.blockedWith(likerId);
        const recipients = (target ? [target.authorId] : await this.postOwners(post)).filter(
          (u) => u !== likerId && !blocked.has(u),
        );
        const total = target ? target.likeCount : post.likeCount;
        const hour = Math.floor(now / 3_600_000);
        return planCommunityLike({
          userIds: recipients,
          postId: post.id,
          liker: liker.username,
          others: Math.max(0, total - 1),
          onComment: !!target,
          dedupeKey: `like:${commentId ?? post.id}:${hour}`,
        });
      }
      case 'job.offer_created':
      case 'job.offer_answered': {
        const offer = await this.prisma.jobOffer.findUnique({
          where: { id: id('offerId') ?? '' },
          select: {
            id: true,
            title: true,
            status: true,
            barbershop: { select: { name: true, members: { select: { userId: true } } } },
            barberProfile: { select: { userId: true, displayName: true } },
          },
        });
        if (!offer) return [];
        if (message.type === 'job.offer_created') {
          return planJobOfferReceived({
            userId: offer.barberProfile.userId,
            offerId: offer.id,
            barbershopName: offer.barbershop.name,
            title: offer.title,
          });
        }
        return planJobOfferAnswered({
          userIds: offer.barbershop.members.map((m) => m.userId),
          offerId: offer.id,
          barberName: offer.barberProfile.displayName,
          title: offer.title,
          accepted: offer.status === 'ACCEPTED',
        });
      }
      case 'billing.subscription': {
        const sub = await this.prisma.subscription.findUnique({
          where: { id: id('subscriptionId') ?? '' },
          select: {
            id: true,
            checkoutUrl: true,
            trialEndsAt: true,
            graceUntil: true,
            currentPeriodEnd: true,
            nextPriceAmount: true,
            nextPriceFrom: true,
            currency: true,
            plan: { select: { name: true } },
            barbershop: {
              select: {
                name: true,
                timezone: true,
                members: { where: { role: 'OWNER' }, select: { userId: true } },
              },
            },
          },
        });
        if (!sub) return [];
        return planSubscriptionNotice(String(p.notice), {
          subscriptionId: sub.id,
          userIds: sub.barbershop.members.map((m) => m.userId),
          planName: sub.plan.name,
          barbershopName: sub.barbershop.name,
          checkoutUrl: sub.checkoutUrl,
          trialEndsAt: sub.trialEndsAt,
          graceUntil: sub.graceUntil,
          currentPeriodEnd: sub.currentPeriodEnd,
          nextPriceAmount: sub.nextPriceAmount,
          nextPriceFrom: sub.nextPriceFrom,
          currency: sub.currency,
          timezone: sub.barbershop.timezone,
        });
      }
      case 'billing.membership': {
        const membership = await this.prisma.membership.findUnique({
          where: { id: id('membershipId') ?? '' },
          select: {
            id: true,
            userId: true,
            checkoutUrl: true,
            currentPeriodEnd: true,
            membershipPlan: { select: { name: true } },
            barbershop: { select: { name: true, timezone: true } },
            lots: { where: { expiresAt: { gt: new Date(now) } }, select: { remaining: true } },
          },
        });
        if (!membership) return [];
        return planMembershipNotice(String(p.notice), {
          membershipId: membership.id,
          userId: membership.userId,
          planName: membership.membershipPlan.name,
          barbershopName: membership.barbershop.name,
          checkoutUrl: membership.checkoutUrl,
          currentPeriodEnd: membership.currentPeriodEnd,
          credits: membership.lots.reduce((sum, l) => sum + l.remaining, 0),
          timezone: membership.barbershop.timezone,
        });
      }
      case 'message.sent': {
        const message = await this.prisma.message.findUnique({
          where: { id: id('messageId') ?? '' },
          select: {
            side: true,
            createdAt: true,
            conversation: {
              select: {
                id: true,
                userId: true,
                barbershopId: true,
                barbershopReadAt: true,
                userReadAt: true,
                barbershop: { select: { name: true } },
                user: { select: { username: true } },
              },
            },
          },
        });
        if (!message || (message.side === 'SYSTEM' && !p.notify)) return [];
        const c = message.conversation;
        const toShop = message.side !== 'BARBERSHOP';
        const recipients = toShop ? await this.staffOf(c.barbershopId) : [c.userId];
        const readAt = toShop ? c.barbershopReadAt : c.userReadAt;
        // Correo solo si no había otro mensaje sin leer de este lado antes que este.
        const earlierUnread = await this.prisma.message.count({
          where: {
            conversationId: c.id,
            side: message.side,
            createdAt: { lt: message.createdAt, ...(readAt ? { gt: readAt } : {}) },
          },
        });
        const from =
          message.side === 'SYSTEM' ? 'Charles' : toShop ? c.user.username : c.barbershop.name;
        return planNewMessage({
          recipientIds: recipients,
          conversationId: c.id,
          from,
          withEmail: earlierUnread === 0,
        });
      }
      case 'job.application_created':
      case 'job.application_updated': {
        const application = await this.prisma.jobApplication.findUnique({
          where: { id: id('applicationId') ?? '' },
          select: {
            id: true,
            status: true,
            barberProfile: { select: { userId: true, displayName: true } },
            posting: {
              select: { title: true, barbershopId: true, barbershop: { select: { name: true } } },
            },
          },
        });
        if (!application) return [];
        return message.type === 'job.application_created'
          ? planJobApplication({
              staffIds: await this.staffOf(application.posting.barbershopId),
              applicationId: application.id,
              barberName: application.barberProfile.displayName,
              postingTitle: application.posting.title,
            })
          : planApplicationUpdate({
              userId: application.barberProfile.userId,
              applicationId: application.id,
              status: application.status,
              barbershopName: application.posting.barbershop.name,
              postingTitle: application.posting.title,
            });
      }
      case 'barbershop.suspended': {
        const barbershopId = id('barbershopId');
        const shop = barbershopId
          ? await this.prisma.barbershop.findUnique({
              where: { id: barbershopId },
              select: { id: true, name: true },
            })
          : null;
        if (!shop) return [];
        return planBarbershopSuspended({
          staffIds: await this.staffOf(shop.id),
          barbershopId: shop.id,
          barbershopName: shop.name,
        });
      }
    }
    return [];
  }

  /**
   * Guarda los avisos, uno por persona y canal permitido. Idempotente: la clave única
   * (persona, `dedupe_key`, canal) evita duplicados aunque el evento llegue dos veces.
   */
  async persist(
    plans: PlannedNotification[],
    dedupeBase: string,
    timezone: string,
    extraData: Record<string, unknown> = {},
  ): Promise<number> {
    const recipients = await this.recipients(plans.map((p) => p.userId));
    const quiet = await this.quietHours(timezone);
    const now = this.clock.now();
    const rows: Prisma.NotificationCreateManyInput[] = [];
    for (const plan of plans) {
      const who = recipients.get(plan.userId);
      if (!who || who.deleted) continue;
      // Una cuenta deshabilitada solo recibe los avisos sobre su propia cuenta.
      if (who.status !== 'ACTIVE' && !ACCOUNT_LEVEL_TYPES.has(plan.type)) continue;
      if (plan.reminder && !who.reminders) continue;
      for (const channel of plan.channels) {
        if (!plan.mandatory && !who.channels.has(channel)) continue;
        const text =
          channel === 'PUSH'
            ? plan.push
            : channel === 'EMAIL' && plan.email
              ? { title: plan.email.subject, body: plan.email.text }
              : plan.detail;
        const sendAfter = channel === 'PUSH' && !plan.urgent ? nextAllowedAt(now, quiet) : now;
        rows.push({
          userId: plan.userId,
          type: plan.type,
          title: text.title,
          body: text.body,
          channel,
          dedupeKey: `${plan.dedupeKey ?? dedupeBase}:${plan.type}`,
          data: { type: plan.type, resource: plan.resource, ...extraData },
          status: channel === 'IN_APP' ? 'SENT' : 'PENDING',
          sentAt: channel === 'IN_APP' ? new Date(now) : null,
          sendAfter: new Date(sendAfter),
          createdAt: new Date(now),
        });
      }
    }
    if (rows.length === 0) return 0;
    const { count } = await this.prisma.notification.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return count;
  }

  // ───────────── Recordatorios ─────────────

  /**
   * Busca las reservas confirmadas cuyos recordatorios tocan ahora (24 y 2 h antes, adelantados
   * si caen en el horario silencioso). Cada recordatorio se guarda una sola vez por reserva.
   */
  async scanReminders(): Promise<number> {
    const hours = normalizeReminderHours(
      await this.settings.get(SettingKey.NOTIFICATIONS_REMINDER_HOURS),
    ) ?? [...NOTIFICATION_DEFAULTS.reminderHours];
    if (hours.length === 0) return 0;
    const now = this.clock.now();
    // Hasta 12 h extra: un recordatorio adelantado por el horario silencioso sale antes.
    const horizon = new Date(now + (Math.max(...hours) + 12) * 3_600_000);
    const bookings = await this.prisma.booking.findMany({
      where: { status: 'CONFIRMED', startAt: { gt: new Date(now), lte: horizon } },
      select: { id: true },
      orderBy: { startAt: 'asc' },
      take: 2000,
    });
    let created = 0;
    for (const { id } of bookings) {
      const ctx = await this.bookingContext(id);
      if (!ctx) continue;
      const confirmed = await this.prisma.bookingStatusHistory.findFirst({
        where: { bookingId: id, toStatus: 'CONFIRMED' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      const quiet = await this.quietHours(ctx.timezone);
      for (const h of hours) {
        if (
          !reminderDue({
            startAt: ctx.startAt,
            confirmedAt: confirmed?.createdAt.getTime() ?? 0,
            hours: h,
            now,
            quiet,
          })
        ) {
          continue;
        }
        created += await this.persist([planReminder(ctx, h)], `reminder:${h}:${id}`, ctx.timezone, {
          reminderBookingId: id,
        });
      }
    }
    return created;
  }

  // ───────────── Entrega ─────────────

  /** Entrega un lote de push y correos pendientes. Devuelve cuántos procesó. */
  async deliverDue(limit = 50): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM notifications
         WHERE channel <> 'IN_APP'
           AND send_after <= ${new Date(now)}
           AND (status = 'PENDING'
                OR (status = 'SENDING' AND claimed_at < ${new Date(now - CLAIM_TIMEOUT_MS)}))
         ORDER BY send_after, id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      await tx.notification.updateMany({
        where: { id: { in: ids } },
        data: { status: 'SENDING', claimedAt: new Date(now), attempts: { increment: 1 } },
      });
      return tx.notification.findMany({ where: { id: { in: ids } } });
    });
    for (const row of claimed) {
      try {
        await this.deliverOne(row);
      } catch (error) {
        await this.retryLater(row.id, row.attempts, error);
      }
    }
    return claimed.length;
  }

  private async deliverOne(row: {
    id: string;
    userId: string;
    channel: NotificationChannel;
    title: string;
    body: string;
    type: string;
    data: Prisma.JsonValue;
  }): Promise<void> {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const reminderBookingId = data.reminderBookingId;
    if (typeof reminderBookingId === 'string') {
      // Nunca un recordatorio de una reserva cancelada o que ya empezó.
      const booking = await this.prisma.booking.findUnique({
        where: { id: reminderBookingId },
        select: { status: true, startAt: true },
      });
      if (
        !booking ||
        booking.status !== 'CONFIRMED' ||
        booking.startAt.getTime() <= this.clock.now()
      ) {
        await this.finish(row.id, 'SKIPPED', 'NOT_APPLICABLE');
        return;
      }
    }

    if (row.channel === 'EMAIL') {
      const to = await this.users.contactEmail(row.userId);
      if (!to) {
        await this.finish(row.id, 'SKIPPED', 'NO_EMAIL');
        return;
      }
      await this.mailer.send({
        to,
        subject: row.title,
        text: row.body,
        category: `notification:${row.type}`,
      });
      await this.finish(row.id, 'SENT');
      return;
    }

    const targets = await this.devices.targets(row.userId);
    if (targets.length === 0) {
      await this.finish(row.id, 'SKIPPED', 'NO_DEVICES');
      return;
    }
    const navigation = { type: data.type, resource: data.resource };
    const results = await this.push.send(
      targets.map((t) => ({ to: t.pushToken, title: row.title, body: row.body, data: navigation })),
    );
    const invalid: string[] = [];
    const tickets: { ticketId: string; deviceId: string }[] = [];
    let transient = false;
    results.forEach((result, i) => {
      const target = targets[i]!;
      if (result.ok) tickets.push({ ticketId: result.ticketId, deviceId: target.id });
      else if (result.error === DEVICE_NOT_REGISTERED) invalid.push(target.id);
      else if (!result.permanent) transient = true;
    });
    await this.devices.removeInvalid(invalid);
    if (tickets.length > 0) {
      await this.finish(row.id, 'SENT', null, { tickets });
    } else if (transient) {
      throw new Error('PUSH_TRANSIENT');
    } else {
      await this.finish(
        row.id,
        invalid.length > 0 ? 'SKIPPED' : 'FAILED',
        invalid.length > 0 ? 'NO_VALID_DEVICES' : 'PUSH_REJECTED',
      );
    }
  }

  private async finish(
    id: string,
    status: 'SENT' | 'SKIPPED' | 'FAILED',
    lastError: string | null = null,
    providerData?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status,
        lastError,
        claimedAt: null,
        ...(status === 'SENT' ? { sentAt: new Date(this.clock.now()) } : {}),
        ...(providerData ? { providerData: providerData as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /** Reintento con espera creciente (1, 2, 4, 8 min); al quinto intento queda FAILED. */
  private async retryLater(id: string, attempts: number, error: unknown): Promise<void> {
    const code =
      error instanceof Error && error.message === 'PUSH_TRANSIENT'
        ? 'PUSH_TRANSIENT'
        : 'PROVIDER_UNAVAILABLE';
    if (attempts >= MAX_ATTEMPTS) {
      await this.finish(id, 'FAILED', code);
      this.logger.warn({ notificationId: id }, 'Notificación fallida tras varios intentos');
      return;
    }
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: 'PENDING',
        claimedAt: null,
        lastError: code,
        sendAfter: new Date(this.clock.now() + 2 ** (attempts - 1) * 60_000),
      },
    });
  }

  /** Recibos de Expo: los tokens marcados `DeviceNotRegistered` se borran. */
  async checkReceipts(limit = 300): Promise<number> {
    const pending = await this.prisma.$queryRaw<{ id: string; provider_data: Prisma.JsonObject }[]>`
      SELECT id::text AS id, provider_data FROM notifications
       WHERE channel = 'PUSH' AND status = 'SENT'
         AND sent_at <= ${new Date(this.clock.now() - RECEIPTS_AFTER_MS)}
         AND provider_data ? 'tickets' AND NOT provider_data ? 'receiptsCheckedAt'
       ORDER BY sent_at LIMIT ${limit}`;
    if (pending.length === 0) return 0;
    const tickets = pending.flatMap(
      (r) =>
        (r.provider_data as { tickets?: { ticketId: string; deviceId: string }[] }).tickets ?? [],
    );
    const receipts = await this.push.receipts(tickets.map((t) => t.ticketId));
    const invalid = tickets
      .filter((t) => {
        const receipt = receipts.get(t.ticketId);
        return receipt && !receipt.ok && receipt.error === DEVICE_NOT_REGISTERED;
      })
      .map((t) => t.deviceId);
    await this.devices.removeInvalid(invalid);
    const checkedAt = new Date(this.clock.now()).toISOString();
    for (const row of pending) {
      await this.prisma.notification.update({
        where: { id: row.id },
        data: {
          providerData: {
            ...row.provider_data,
            receiptsCheckedAt: checkedAt,
          },
        },
      });
    }
    return pending.length;
  }

  /** Conservación: se borran los avisos con más de `notifications.retention_days` (90). */
  async purgeOld(): Promise<number> {
    const days = await this.settings.positiveInt(
      SettingKey.NOTIFICATIONS_RETENTION_DAYS,
      NOTIFICATION_DEFAULTS.retentionDays,
    );
    const { count } = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: new Date(this.clock.now() - days * 24 * 3_600_000) } },
    });
    return count;
  }

  // ───────────── Bandeja ─────────────

  async inbox(userId: string, query: NotificationQueryDto): Promise<Page<NotificationDto>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        channel: 'IN_APP',
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((n) => {
        const resource = ((n.data ?? {}) as { resource?: { type: string; id: string | null } })
          .resource ?? { type: 'account', id: null };
        return {
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          resource,
          createdAt: n.createdAt.toISOString(),
          readAt: n.readAt?.toISOString() ?? null,
        };
      }),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, channel: 'IN_APP', readAt: null },
    });
  }

  async markRead(userId: string, id: string): Promise<void> {
    const found = await this.prisma.notification.findFirst({
      where: { id, userId, channel: 'IN_APP' },
      select: { readAt: true },
    });
    if (!found) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El aviso no existe.', HttpStatus.NOT_FOUND);
    }
    if (!found.readAt) {
      await this.prisma.notification.update({
        where: { id },
        data: { readAt: new Date(this.clock.now()) },
      });
    }
  }

  async markAllRead(userId: string): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date(this.clock.now()) },
    });
    return count;
  }

  // ───────────── Auxiliares ─────────────

  private async bookingContext(bookingId: string): Promise<BookingContext | null> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        clientId: true,
        barbershopId: true,
        startAt: true,
        serviceNameSnapshot: true,
        barber: { select: { userId: true } },
        barbershop: { select: { name: true, timezone: true } },
        payments: {
          select: {
            currency: true,
            refunds: {
              where: { reasonType: { not: 'MANUAL' } },
              orderBy: { createdAt: 'desc' },
              select: { amount: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!booking) return null;
    const refund = booking.payments
      .flatMap((p) => p.refunds.map((r) => ({ amount: r.amount, currency: p.currency })))
      .at(0);
    return {
      bookingId: booking.id,
      clientId: booking.clientId,
      barberUserId: booking.barber.userId,
      staffIds: await this.staffOf(booking.barbershopId),
      barbershopName: booking.barbershop.name,
      timezone: booking.barbershop.timezone,
      startAt: booking.startAt.getTime(),
      serviceName: booking.serviceNameSnapshot,
      refund: refund ?? null,
    };
  }

  private async staffOf(barbershopId: string): Promise<string[]> {
    const members = await this.prisma.barbershopMember.findMany({
      where: { barbershopId, role: { in: ['OWNER', 'MANAGER'] } },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    });
    return members.map((m) => m.userId);
  }

  private async timezoneOf(message: OutboxMessage): Promise<string> {
    const p = message.payload;
    const barbershopId = typeof p.barbershopId === 'string' ? p.barbershopId : null;
    if (!barbershopId) return DEFAULT_TIMEZONE;
    const shop = await this.prisma.barbershop.findUnique({
      where: { id: barbershopId },
      select: { timezone: true },
    });
    return shop?.timezone ?? DEFAULT_TIMEZONE;
  }

  private async quietHours(timezone: string): Promise<QuietHours> {
    const [start, end] = await Promise.all([
      this.settings.get(SettingKey.NOTIFICATIONS_QUIET_START),
      this.settings.get(SettingKey.NOTIFICATIONS_QUIET_END),
    ]);
    return {
      start: isValidHhMm(start) ? start : NOTIFICATION_DEFAULTS.quietStart,
      end: isValidHhMm(end) ? end : NOTIFICATION_DEFAULTS.quietEnd,
      timezone,
    };
  }

  /** Preferencias: canales (por defecto todos) e interruptor de recordatorios (por defecto sí). */
  private async recipients(userIds: string[]): Promise<Map<string, Recipient>> {
    const rows = await this.users.notificationTargets([...new Set(userIds)]);
    return new Map(
      rows.map((u) => {
        const prefs = (u.preferences ?? {}) as {
          notificationChannels?: unknown;
          reminders?: unknown;
        };
        const channels = Array.isArray(prefs.notificationChannels)
          ? prefs.notificationChannels.filter((c): c is NotificationChannel =>
              CHANNELS.includes(c as NotificationChannel),
            )
          : CHANNELS;
        return [
          u.id,
          {
            status: u.status,
            deleted: u.deleted,
            channels: new Set(channels),
            reminders: prefs.reminders !== false,
          },
        ];
      }),
    );
  }
  /** Cuentas con bloqueo (en cualquier sentido) con esta. */
  private async blockedWith(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.userBlock.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    return new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)));
  }

  /** Quienes responden por una publicación: OWNER y MANAGER de la barbería, o el dueño del perfil. */
  private async postOwners(post: {
    createdById: string;
    barbershopId: string | null;
    authorProfileId: string | null;
  }): Promise<string[]> {
    if (post.barbershopId) {
      const staff = await this.prisma.barbershopMember.findMany({
        where: { barbershopId: post.barbershopId, role: { in: ['OWNER', 'MANAGER'] } },
        select: { userId: true },
      });
      return [...new Set([post.createdById, ...staff.map((s) => s.userId)])];
    }
    return [post.createdById];
  }
}
