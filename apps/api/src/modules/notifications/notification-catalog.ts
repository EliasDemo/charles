import { DateTime } from 'luxon';
import type { NotificationChannel } from '../../generated/prisma/enums';

/**
 * Catálogo de avisos (Fase 10, RF-NOT-001…004): quién recibe cada uno, por qué canales y con qué
 * texto (solo español, plantillas en el backend). Funciones puras: se prueban aisladas.
 *
 * Reglas de contenido:
 * - El **push** no lleva datos sensibles (ni montos, ni nombres, ni motivos): solo lo necesario
 *   para que la persona abra la app.
 * - La bandeja y el correo pueden dar detalle (servicio, barbería, hora, monto devuelto), nunca
 *   el nombre completo ni el contacto de otra persona.
 * - Todo aviso lleva `resource` (tipo e ID) para que la app abra la pantalla correcta.
 */

export type NotificationType =
  | 'BOOKING_CONFIRMED'
  | 'NEW_BOOKING'
  | 'BOOKING_CANCELLED'
  | 'BOOKING_CANCELLED_BY_CLIENT'
  | 'BOOKING_CANCELLED_BY_BARBERSHOP'
  | 'BOOKING_CANCELLED_BY_SUPPORT'
  | 'PAYMENT_REJECTED'
  | 'BOOKING_EXPIRED'
  | 'NO_SHOW'
  | 'BOOKING_REMINDER'
  | 'REFUND_COMPLETED'
  | 'REFUND_FAILED'
  | 'NEW_REVIEW'
  | 'SUPPORT_REPLY'
  | 'ACCOUNT_DISABLED'
  | 'BARBERSHOP_SUSPENDED'
  | 'ACCOUNT_DELETION_REQUESTED'
  | 'ACCOUNT_DELETION_REMINDER'
  | 'ACCOUNT_DELETION_CANCELLED'
  | 'BARBERSHOP_APPROVED'
  | 'BARBERSHOP_CHANGES_REQUESTED'
  | 'NEW_MESSAGE'
  | 'JOB_APPLICATION_RECEIVED'
  | 'JOB_APPLICATION_UPDATED'
  | 'PLAN_UPDATE'
  | 'MEMBERSHIP_UPDATE'
  | 'JOB_OFFER_RECEIVED'
  | 'JOB_OFFER_ANSWERED'
  | 'COMMUNITY_COMMENT'
  | 'COMMUNITY_REPLY'
  | 'COMMUNITY_MENTION'
  | 'COMMUNITY_LIKE'
  | 'COMMUNITY_NEW_POST';

export type ResourceType =
  | 'booking'
  | 'review'
  | 'ticket'
  | 'barbershop'
  | 'account'
  | 'conversation'
  | 'job_application'
  | 'subscription'
  | 'membership'
  | 'job_offer'
  | 'post';

export interface Text {
  title: string;
  body: string;
}

export interface PlannedNotification {
  userId: string;
  type: NotificationType;
  channels: NotificationChannel[];
  /** Seguridad y pagos: se envían aunque la persona haya apagado ese canal. */
  mandatory: boolean;
  /** Urgente: el push no espera al fin del horario silencioso. */
  urgent: boolean;
  /** Recordatorio: depende además del interruptor de recordatorios. */
  reminder?: boolean;
  push: Text;
  detail: Text;
  email?: { subject: string; text: string };
  resource: { type: ResourceType; id: string | null };
  /** Agrupar: misma clave = un solo aviso (p. ej. me gusta por publicación y hora). */
  dedupeKey?: string;
}

export interface BookingContext {
  bookingId: string;
  clientId: string;
  /** Cuenta vinculada al barbero asignado, si la tiene. */
  barberUserId: string | null;
  /** OWNER y MANAGER de la barbería. */
  staffIds: string[];
  barbershopName: string;
  timezone: string;
  startAt: number;
  serviceName: string;
  /** Devolución pedida por esta cancelación, si la hay. */
  refund: { amount: number; currency: string } | null;
}

export interface BookingEvent {
  status: string;
  from: string | null;
  actorRole: string | null;
}

const ALL: NotificationChannel[] = ['PUSH', 'IN_APP', 'EMAIL'];
const PUSH_APP: NotificationChannel[] = ['PUSH', 'IN_APP'];
const APP: NotificationChannel[] = ['IN_APP'];
const APP_EMAIL: NotificationChannel[] = ['IN_APP', 'EMAIL'];
const EMAIL: NotificationChannel[] = ['EMAIL'];
const DAY = 24 * 3_600_000;

export function formatWhen(ms: number, timezone: string): string {
  return DateTime.fromMillis(ms, { zone: timezone })
    .setLocale('es')
    .toFormat("cccc d 'de' LLLL 'a las' HH:mm");
}

export function formatMoney(amount: number, currency: string): string {
  const value = (amount / 100).toFixed(2);
  return currency === 'PEN' ? `S/ ${value}` : `${currency} ${value}`;
}

const emailFooter = '\n\nPuedes ver el detalle en la app de Charles.';

/** Avisos de un cambio de estado de reserva (`booking.*` del outbox). */
export function planBookingEvent(
  event: BookingEvent,
  ctx: BookingContext,
  now: number,
): PlannedNotification[] {
  const when = formatWhen(ctx.startAt, ctx.timezone);
  const what = `${ctx.serviceName} en ${ctx.barbershopName}, ${when}`;
  const resource = { type: 'booking' as const, id: ctx.bookingId };
  const soon = ctx.startAt - now <= DAY;
  const refundText =
    ctx.refund && ctx.refund.amount > 0
      ? ` Te devolveremos ${formatMoney(ctx.refund.amount, ctx.refund.currency)}.`
      : '';
  const plans: PlannedNotification[] = [];
  const add = (p: Omit<PlannedNotification, 'resource'>) => plans.push({ ...p, resource });

  const toBarberAndStaff = (
    type: NotificationType,
    push: Text,
    detail: Text,
    barberChannels: NotificationChannel[],
    staffChannels: NotificationChannel[] | null,
    urgent: boolean,
  ) => {
    if (ctx.barberUserId) {
      add({
        userId: ctx.barberUserId,
        type,
        channels: barberChannels,
        mandatory: false,
        urgent,
        push,
        detail,
        ...(barberChannels.includes('EMAIL')
          ? { email: { subject: detail.title, text: `${detail.body}${emailFooter}` } }
          : {}),
      });
    }
    if (staffChannels) {
      for (const userId of ctx.staffIds) {
        add({ userId, type, channels: staffChannels, mandatory: false, urgent, push, detail });
      }
    }
  };

  switch (event.status) {
    case 'CONFIRMED': {
      const detail = { title: 'Reserva confirmada', body: `${what}.` };
      add({
        userId: ctx.clientId,
        type: 'BOOKING_CONFIRMED',
        channels: ALL,
        mandatory: false,
        urgent: soon,
        push: { title: 'Reserva confirmada', body: 'Toca para ver los detalles.' },
        detail,
        email: {
          subject: 'Tu reserva está confirmada',
          text: `Tu reserva está confirmada: ${what}.${emailFooter}`,
        },
      });
      toBarberAndStaff(
        'NEW_BOOKING',
        { title: 'Nueva reserva', body: 'Toca para ver la agenda.' },
        { title: 'Nueva reserva', body: `${ctx.serviceName}, ${when}.` },
        ALL,
        PUSH_APP,
        soon,
      );
      break;
    }
    case 'CANCELLED': {
      if (event.from === 'PENDING_PAYMENT') {
        // Pago rechazado (lo cancela el sistema). La cancelación propia de algo no pagado no avisa.
        if (event.actorRole === 'SYSTEM') {
          add({
            userId: ctx.clientId,
            type: 'PAYMENT_REJECTED',
            channels: PUSH_APP,
            mandatory: true,
            urgent: true,
            push: { title: 'Pago no confirmado', body: 'Toca para ver los detalles.' },
            detail: {
              title: 'No pudimos confirmar tu pago',
              body: `La reserva de ${what} se canceló porque el pago fue rechazado.`,
            },
          });
        }
        break;
      }
      const cancelledPush = { title: 'Reserva cancelada', body: 'Toca para ver los detalles.' };
      if (event.actorRole === 'CLIENT') {
        add({
          userId: ctx.clientId,
          type: 'BOOKING_CANCELLED',
          channels: ALL,
          mandatory: false,
          urgent: soon,
          push: cancelledPush,
          detail: { title: 'Cancelaste tu reserva', body: `${what}.${refundText}` },
          email: {
            subject: 'Cancelaste tu reserva',
            text: `Cancelaste tu reserva: ${what}.${refundText}${emailFooter}`,
          },
        });
        toBarberAndStaff(
          'BOOKING_CANCELLED_BY_CLIENT',
          cancelledPush,
          { title: 'El cliente canceló una reserva', body: `${ctx.serviceName}, ${when}.` },
          PUSH_APP,
          PUSH_APP,
          soon,
        );
      } else if (event.actorRole === 'BARBERSHOP' || event.actorRole === 'SUPPORT') {
        const bySupport = event.actorRole === 'SUPPORT';
        const detail = {
          title: bySupport ? 'Tu reserva fue cancelada' : 'La barbería canceló tu reserva',
          body: `${what}.${refundText || ' No había pagos que devolver.'}`,
        };
        add({
          userId: ctx.clientId,
          type: bySupport ? 'BOOKING_CANCELLED_BY_SUPPORT' : 'BOOKING_CANCELLED_BY_BARBERSHOP',
          channels: ALL,
          mandatory: true,
          urgent: soon,
          push: cancelledPush,
          detail,
          email: { subject: detail.title, text: `${detail.title}: ${detail.body}${emailFooter}` },
        });
        toBarberAndStaff(
          'BOOKING_CANCELLED',
          cancelledPush,
          { title: 'Reserva cancelada', body: `${ctx.serviceName}, ${when}.` },
          bySupport ? APP : PUSH_APP,
          null,
          soon,
        );
      }
      break;
    }
    case 'EXPIRED':
      add({
        userId: ctx.clientId,
        type: 'BOOKING_EXPIRED',
        channels: PUSH_APP,
        mandatory: true,
        urgent: true,
        push: { title: 'Reserva vencida', body: 'Toca para ver los detalles.' },
        detail: {
          title: 'Tu reserva venció',
          body: `La reserva de ${what} venció porque no se completó el pago a tiempo.`,
        },
      });
      break;
    case 'NO_SHOW':
      add({
        userId: ctx.clientId,
        type: 'NO_SHOW',
        channels: APP,
        mandatory: false,
        urgent: false,
        push: { title: 'Reserva no asistida', body: 'Toca para ver los detalles.' },
        detail: {
          title: 'Reserva marcada como no asistida',
          body: `La barbería marcó que no asististe a ${what}. Si es un error, escribe a soporte.`,
        },
      });
      break;
  }
  return dedupeByUser(plans);
}

/** Recordatorio de una reserva confirmada. */
export function planReminder(ctx: BookingContext, hours: number): PlannedNotification {
  const when = formatWhen(ctx.startAt, ctx.timezone);
  return {
    userId: ctx.clientId,
    type: 'BOOKING_REMINDER',
    channels: PUSH_APP,
    mandatory: false,
    urgent: true, // su hora ya respeta el horario silencioso
    reminder: true,
    push: { title: 'Recordatorio de tu cita', body: 'Toca para ver los detalles.' },
    detail: {
      title: hours >= 24 ? 'Tu cita es mañana' : 'Tu cita es pronto',
      body: `${ctx.serviceName} en ${ctx.barbershopName}, ${when}.`,
    },
    resource: { type: 'booking', id: ctx.bookingId },
  };
}

export function planRefund(input: {
  outcome: 'SUCCEEDED' | 'FAILED';
  clientId: string;
  bookingId: string;
  amount: number;
  currency: string;
}): PlannedNotification {
  const money = formatMoney(input.amount, input.currency);
  const detail =
    input.outcome === 'SUCCEEDED'
      ? {
          title: 'Devolución completada',
          body: `Te devolvimos ${money}. Puede tardar unos días en verse en tu cuenta o tarjeta.`,
        }
      : {
          title: 'No pudimos completar tu devolución',
          body: `La devolución de ${money} no se pudo completar. Soporte la revisará y te contactará.`,
        };
  return {
    userId: input.clientId,
    type: input.outcome === 'SUCCEEDED' ? 'REFUND_COMPLETED' : 'REFUND_FAILED',
    channels: APP_EMAIL,
    mandatory: true,
    urgent: false,
    push: { title: detail.title, body: 'Toca para ver los detalles.' },
    detail,
    email: { subject: detail.title, text: `${detail.body}${emailFooter}` },
    resource: { type: 'booking', id: input.bookingId },
  };
}

export function planNewReview(input: {
  staffIds: string[];
  reviewId: string;
  rating: number;
}): PlannedNotification[] {
  return input.staffIds.map((userId) => ({
    userId,
    type: 'NEW_REVIEW' as const,
    channels: APP,
    mandatory: false,
    urgent: false,
    push: { title: 'Nueva valoración', body: 'Toca para verla.' },
    detail: {
      title: 'Nueva valoración',
      body: `Recibiste una valoración de ${input.rating} ${input.rating === 1 ? 'estrella' : 'estrellas'}.`,
    },
    resource: { type: 'review' as const, id: input.reviewId },
  }));
}

export function planSupportReply(input: {
  userId: string;
  ticketId: string;
  subject: string;
}): PlannedNotification {
  return {
    userId: input.userId,
    type: 'SUPPORT_REPLY',
    channels: PUSH_APP,
    mandatory: false,
    urgent: false,
    push: { title: 'Soporte respondió', body: 'Toca para ver tu solicitud.' },
    detail: {
      title: 'Soporte respondió',
      body: `Hay una respuesta en tu solicitud «${input.subject}».`,
    },
    resource: { type: 'ticket', id: input.ticketId },
  };
}

export function planAccountDisabled(userId: string): PlannedNotification {
  const body =
    'Tu cuenta de Charles fue deshabilitada. Si crees que es un error, escribe a soporte desde la ' +
    'opción «Ayuda» de la app, con tu correo y tu contraseña.';
  return {
    userId,
    type: 'ACCOUNT_DISABLED',
    channels: EMAIL,
    mandatory: true,
    urgent: true,
    push: { title: 'Cuenta deshabilitada', body: 'Abre la app para más información.' },
    detail: { title: 'Cuenta deshabilitada', body },
    email: { subject: 'Tu cuenta de Charles fue deshabilitada', text: body },
    resource: { type: 'account', id: null },
  };
}

export function planBarbershopSuspended(input: {
  staffIds: string[];
  barbershopId: string;
  barbershopName: string;
}): PlannedNotification[] {
  const body =
    `${input.barbershopName} fue suspendida y no recibe reservas nuevas. ` +
    'Para más información, escribe a soporte desde la app.';
  return input.staffIds.map((userId) => ({
    userId,
    type: 'BARBERSHOP_SUSPENDED' as const,
    channels: APP_EMAIL,
    mandatory: true,
    urgent: true,
    push: { title: 'Barbería suspendida', body: 'Abre la app para más información.' },
    detail: { title: 'Tu barbería fue suspendida', body },
    email: { subject: 'Tu barbería fue suspendida', text: body },
    resource: { type: 'barbershop' as const, id: input.barbershopId },
  }));
}

/**
 * Alta con revisión: aviso a OWNER y MANAGER al aprobarse o al pedirse cambios. El motivo va en la
 * bandeja y el correo, nunca en el push.
 */
export function planBarbershopReview(input: {
  staffIds: string[];
  barbershopId: string;
  barbershopName: string;
  outcome: 'APPROVED' | 'CHANGES_REQUESTED';
  reason: string | null;
}): PlannedNotification[] {
  const approved = input.outcome === 'APPROVED';
  const detail = approved
    ? {
        title: 'Tu barbería fue aprobada',
        body: `${input.barbershopName} ya es visible en Charles y puede recibir reservas.`,
      }
    : {
        title: 'Tu barbería necesita cambios',
        body:
          `Revisamos ${input.barbershopName} y necesitamos que corrijas algo antes de publicarla: ` +
          `${input.reason ?? 'revisa los datos'}. Corrígelo y vuelve a enviarla a revisión.`,
      };
  return input.staffIds.map((userId) => ({
    userId,
    type: approved ? ('BARBERSHOP_APPROVED' as const) : ('BARBERSHOP_CHANGES_REQUESTED' as const),
    channels: ALL,
    mandatory: true,
    urgent: false,
    push: {
      title: approved ? 'Barbería aprobada' : 'Tu barbería necesita cambios',
      body: 'Toca para ver los detalles.',
    },
    detail,
    email: { subject: detail.title, text: `${detail.body}${emailFooter}` },
    resource: { type: 'barbershop' as const, id: input.barbershopId },
  }));
}

/**
 * Eliminación de cuenta: correo obligatorio (seguridad). Sin bandeja: la cuenta no tiene sesión
 * normal mientras está pendiente.
 */
export function planAccountDeletion(input: {
  userId: string;
  kind: 'REQUESTED' | 'REMINDER' | 'CANCELLED';
  scheduledFor: number | null;
}): PlannedNotification {
  const when = input.scheduledFor
    ? DateTime.fromMillis(input.scheduledFor, { zone: 'America/Lima' })
        .setLocale('es')
        .toFormat("d 'de' LLLL 'de' yyyy")
    : '';
  const cancelHow =
    'Si cambias de opinión, abre la app, entra con tu correo y tu contraseña y elige ' +
    '«Cancelar eliminación» antes de esa fecha.';
  const text =
    input.kind === 'CANCELLED'
      ? {
          subject: 'Cancelaste la eliminación de tu cuenta',
          body: 'Tu cuenta de Charles sigue activa. Ya puedes volver a iniciar sesión. Las reservas que se cancelaron al solicitar la eliminación no se restauran.',
        }
      : input.kind === 'REMINDER'
        ? {
            subject: 'Tu cuenta de Charles se eliminará en 3 días',
            body: `Tu cuenta se eliminará el ${when}. ${cancelHow}`,
          }
        : {
            subject: 'Programamos la eliminación de tu cuenta',
            body: `Recibimos tu solicitud. Tu cuenta de Charles se eliminará el ${when}. ${cancelHow}`,
          };
  const type =
    input.kind === 'CANCELLED'
      ? 'ACCOUNT_DELETION_CANCELLED'
      : input.kind === 'REMINDER'
        ? 'ACCOUNT_DELETION_REMINDER'
        : 'ACCOUNT_DELETION_REQUESTED';
  return {
    userId: input.userId,
    type,
    channels: EMAIL,
    mandatory: true,
    urgent: true,
    push: { title: 'Tu cuenta', body: 'Abre la app para más información.' },
    detail: { title: text.subject, body: text.body },
    email: { subject: text.subject, text: text.body },
    resource: { type: 'account', id: null },
  };
}

/** Una persona con varios papeles (p. ej. dueña y barbera) recibe un solo aviso: el primero. */
function dedupeByUser(plans: PlannedNotification[]): PlannedNotification[] {
  const seen = new Set<string>();
  return plans.filter((p) => {
    if (seen.has(p.userId)) return false;
    seen.add(p.userId);
    return true;
  });
}

// ───────────── Carrera del barbero: correo interno y bolsa de trabajo ─────────────

/**
 * Mensaje nuevo en el correo interno. Nunca lleva el contenido (solo quién escribe). El correo
 * electrónico se envía solo con el primer mensaje sin leer de la conversación, para no saturar.
 */
export function planNewMessage(input: {
  recipientIds: string[];
  conversationId: string;
  from: string;
  withEmail: boolean;
}): PlannedNotification[] {
  return input.recipientIds.map((userId) => ({
    userId,
    type: 'NEW_MESSAGE' as const,
    channels: input.withEmail ? ALL : PUSH_APP,
    mandatory: false,
    urgent: true,
    push: { title: 'Mensaje nuevo', body: 'Toca para leerlo en Charles.' },
    detail: { title: 'Mensaje nuevo', body: `${input.from} te escribió.` },
    email: {
      subject: `Tienes un mensaje nuevo de ${input.from}`,
      text:
        `${input.from} te escribió en Charles. Por tu privacidad, el mensaje no va en este correo: ` +
        'ábrelo en la app, en «Mensajes».',
    },
    resource: { type: 'conversation' as const, id: input.conversationId },
  }));
}

export function planJobApplication(input: {
  staffIds: string[];
  applicationId: string;
  barberName: string;
  postingTitle: string;
}): PlannedNotification[] {
  return input.staffIds.map((userId) => ({
    userId,
    type: 'JOB_APPLICATION_RECEIVED' as const,
    channels: ALL,
    mandatory: false,
    urgent: false,
    push: { title: 'Nueva postulación', body: 'Un barbero postuló a tu oferta.' },
    detail: {
      title: 'Nueva postulación',
      body: `${input.barberName} postuló a «${input.postingTitle}».`,
    },
    email: {
      subject: `Nueva postulación a «${input.postingTitle}»`,
      text: `${input.barberName} postuló a tu oferta «${input.postingTitle}». Revísala en la app.`,
    },
    resource: { type: 'job_application' as const, id: input.applicationId },
  }));
}

const APPLICATION_TEXT: Record<string, string> = {
  SHORTLISTED: 'te preseleccionó',
  REJECTED: 'no continuará con tu postulación',
  HIRED: '¡te contrató! Ya apareces en su equipo',
};

export function planApplicationUpdate(input: {
  userId: string;
  applicationId: string;
  status: string;
  barbershopName: string;
  postingTitle: string;
}): PlannedNotification[] {
  const text = APPLICATION_TEXT[input.status];
  if (!text) return [];
  return [
    {
      userId: input.userId,
      type: 'JOB_APPLICATION_UPDATED',
      channels: ALL,
      mandatory: false,
      urgent: false,
      push: { title: 'Tu postulación', body: 'Hay novedades en tu postulación.' },
      detail: {
        title: 'Tu postulación',
        body: `${input.barbershopName} ${text} («${input.postingTitle}»).`,
      },
      email: {
        subject: `Novedades de tu postulación a «${input.postingTitle}»`,
        text: `${input.barbershopName} ${text} («${input.postingTitle}»).`,
      },
      resource: { type: 'job_application', id: input.applicationId },
    },
  ];
}

// ───────────── Fases 15 y 16: planes y membresías ─────────────

const longDate = (at: Date, timezone: string): string =>
  DateTime.fromJSDate(at).setZone(timezone).setLocale('es').toFormat("d 'de' LLLL 'de' yyyy");

export interface SubscriptionNoticeContext {
  subscriptionId: string;
  /** OWNER de la barbería (quien paga y decide). */
  userIds: string[];
  planName: string;
  barbershopName: string;
  checkoutUrl: string | null;
  trialEndsAt: Date | null;
  graceUntil: Date | null;
  currentPeriodEnd: Date | null;
  nextPriceAmount: number | null;
  nextPriceFrom: Date | null;
  currency: string;
  timezone: string;
}

/** Avisos del plan de una barbería. Son de pagos: se envían siempre (obligatorios). */
export function planSubscriptionNotice(
  notice: string,
  ctx: SubscriptionNoticeContext,
): PlannedNotification[] {
  const date = (d: Date | null) => (d ? longDate(d, ctx.timezone) : '');
  const texts: Record<string, Text | undefined> = {
    checkout_ready: {
      title: 'Completa el pago de tu plan',
      body: `Para activar el plan ${ctx.planName} de ${ctx.barbershopName}, completa el pago en este enlace: ${ctx.checkoutUrl ?? ''}`,
    },
    activated: {
      title: `Plan ${ctx.planName} activo`,
      body: ctx.trialEndsAt
        ? `${ctx.barbershopName} ya tiene el plan ${ctx.planName}. Tu prueba gratis termina el ${date(ctx.trialEndsAt)}.`
        : `${ctx.barbershopName} ya tiene el plan ${ctx.planName}.`,
    },
    trial_ending: {
      title: 'Tu prueba gratis termina pronto',
      body: `La prueba del plan ${ctx.planName} de ${ctx.barbershopName} termina el ${date(ctx.trialEndsAt)}. Luego se cobrará automáticamente.`,
    },
    payment_failed: {
      title: 'No pudimos cobrar tu plan',
      body: `El cobro del plan ${ctx.planName} de ${ctx.barbershopName} falló. Actualiza tu medio de pago antes del ${date(ctx.graceUntil)} para no perder los beneficios.`,
    },
    recovered: {
      title: 'Pago recibido',
      body: `Recibimos el pago del plan ${ctx.planName} de ${ctx.barbershopName}. Todo sigue funcionando.`,
    },
    canceled: {
      title: 'Plan cancelado',
      body: ctx.currentPeriodEnd
        ? `Cancelaste el plan ${ctx.planName} de ${ctx.barbershopName}. Sus beneficios siguen hasta el ${date(ctx.currentPeriodEnd)}.`
        : `Cancelaste el plan ${ctx.planName} de ${ctx.barbershopName}.`,
    },
    expired: {
      title: 'Tu plan terminó',
      body: `El plan ${ctx.planName} de ${ctx.barbershopName} terminó y pasaste al plan gratis. No se borró nada: lo que excede el nuevo límite quedó inactivo y vuelve si mejoras tu plan.`,
    },
    price_change: {
      title: 'Cambio de precio de tu plan',
      body:
        ctx.nextPriceAmount !== null
          ? `Desde el ${date(ctx.nextPriceFrom)}, el plan ${ctx.planName} costará ${formatMoney(ctx.nextPriceAmount, ctx.currency)}. Puedes cancelarlo cuando quieras.`
          : `El precio del plan ${ctx.planName} cambiará en tu próxima renovación.`,
    },
  };
  const text = texts[notice];
  if (!text) return [];
  return ctx.userIds.map((userId) => ({
    userId,
    type: 'PLAN_UPDATE' as const,
    channels: ALL,
    mandatory: true,
    urgent: notice === 'payment_failed',
    push: { title: 'Tu plan', body: 'Hay novedades en el plan de tu barbería.' },
    detail: text,
    email: { subject: text.title, text: text.body },
    resource: { type: 'subscription' as const, id: ctx.subscriptionId },
  }));
}

export interface MembershipNoticeContext {
  membershipId: string;
  userId: string;
  planName: string;
  barbershopName: string;
  checkoutUrl: string | null;
  currentPeriodEnd: Date | null;
  credits: number;
  timezone: string;
}

/** Avisos de la membresía de un cliente. */
export function planMembershipNotice(
  notice: string,
  ctx: MembershipNoticeContext,
): PlannedNotification[] {
  const date = (d: Date | null) => (d ? longDate(d, ctx.timezone) : '');
  const texts: Record<string, Text | undefined> = {
    checkout_ready: {
      title: 'Completa el pago de tu membresía',
      body: `Para activar «${ctx.planName}» en ${ctx.barbershopName}, completa el pago: ${ctx.checkoutUrl ?? ''}`,
    },
    credits_granted: {
      title: 'Tus créditos están listos',
      body: `Tienes ${ctx.credits} crédito${ctx.credits === 1 ? '' : 's'} de «${ctx.planName}» en ${ctx.barbershopName}. Reserva cuando quieras.`,
    },
    payment_failed: {
      title: 'No pudimos cobrar tu membresía',
      body: `El cobro de «${ctx.planName}» en ${ctx.barbershopName} falló. Actualiza tu medio de pago para seguir recibiendo créditos.`,
    },
    canceled: {
      title: 'Membresía cancelada',
      body: `Cancelaste «${ctx.planName}» en ${ctx.barbershopName}. Tus créditos siguen disponibles hasta el ${date(ctx.currentPeriodEnd)}.`,
    },
    expired: {
      title: 'Tu membresía terminó',
      body: `La membresía «${ctx.planName}» en ${ctx.barbershopName} terminó.`,
    },
  };
  const text = texts[notice];
  if (!text) return [];
  return [
    {
      userId: ctx.userId,
      type: 'MEMBERSHIP_UPDATE',
      channels: ALL,
      mandatory: true,
      urgent: false,
      push: { title: 'Tu membresía', body: 'Hay novedades en tu membresía.' },
      detail: text,
      email: { subject: text.title, text: text.body },
      resource: { type: 'membership', id: ctx.membershipId },
    },
  ];
}

// ───────────── Ofertas directas de trabajo ─────────────

/** Al barbero: una barbería le ofreció trabajo. */
export function planJobOfferReceived(input: {
  userId: string;
  offerId: string;
  barbershopName: string;
  title: string;
}): PlannedNotification[] {
  const body = `${input.barbershopName} te ofrece trabajo: «${input.title}». Acéptala o recházala en «Ofertas».`;
  return [
    {
      userId: input.userId,
      type: 'JOB_OFFER_RECEIVED',
      channels: ALL,
      mandatory: false,
      urgent: false,
      push: { title: 'Oferta de trabajo', body: 'Una barbería te ofrece trabajo.' },
      detail: { title: 'Oferta de trabajo', body },
      email: { subject: `Oferta de trabajo de ${input.barbershopName}`, text: body },
      resource: { type: 'job_offer', id: input.offerId },
    },
  ];
}

/** A la barbería (OWNER y MANAGER): el barbero respondió. */
export function planJobOfferAnswered(input: {
  userIds: string[];
  offerId: string;
  barberName: string;
  title: string;
  accepted: boolean;
}): PlannedNotification[] {
  const body = input.accepted
    ? `${input.barberName} aceptó tu oferta «${input.title}» y ya está en tu equipo. Asígnale sus servicios y horario.`
    : `${input.barberName} rechazó tu oferta «${input.title}».`;
  return input.userIds.map((userId) => ({
    userId,
    type: 'JOB_OFFER_ANSWERED' as const,
    channels: ALL,
    mandatory: false,
    urgent: false,
    push: { title: 'Oferta de trabajo', body: 'Un barbero respondió tu oferta.' },
    detail: { title: input.accepted ? 'Oferta aceptada' : 'Oferta rechazada', body },
    email: {
      subject: input.accepted
        ? 'Aceptaron tu oferta de trabajo'
        : 'Rechazaron tu oferta de trabajo',
      text: body,
    },
    resource: { type: 'job_offer' as const, id: input.offerId },
  }));
}

// ───────────── Comunidad ─────────────

const COMMUNITY_CHANNELS: NotificationChannel[] = ['IN_APP', 'PUSH'];

const TYPE_TEXT: Record<string, string> = {
  PROMOTION: 'una promoción',
  EVENT: 'un evento',
  WORK: 'un trabajo nuevo',
  ANNOUNCEMENT: 'un anuncio',
};

const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A quien publicó: un comentario en su publicación. */
export function planCommunityComment(input: {
  userIds: string[];
  postId: string;
  author: string;
  body: string;
}): PlannedNotification[] {
  const body = `@${input.author} comentó: «${clip(input.body)}»`;
  return input.userIds.map((userId) => ({
    userId,
    type: 'COMMUNITY_COMMENT' as const,
    channels: COMMUNITY_CHANNELS,
    mandatory: false,
    urgent: false,
    push: { title: 'Nuevo comentario', body },
    detail: { title: 'Nuevo comentario', body },
    resource: { type: 'post' as const, id: input.postId },
  }));
}

/** A quien escribió el comentario principal: alguien le respondió. */
export function planCommunityReply(input: {
  userId: string;
  postId: string;
  author: string;
  body: string;
}): PlannedNotification[] {
  const body = `@${input.author} respondió tu comentario: «${clip(input.body)}»`;
  return [
    {
      userId: input.userId,
      type: 'COMMUNITY_REPLY',
      channels: COMMUNITY_CHANNELS,
      mandatory: false,
      urgent: false,
      push: { title: 'Te respondieron', body },
      detail: { title: 'Te respondieron', body },
      resource: { type: 'post', id: input.postId },
    },
  ];
}

/** A la cuenta mencionada en un comentario. */
export function planCommunityMention(input: {
  userId: string;
  postId: string;
  author: string;
  body: string;
}): PlannedNotification[] {
  const body = `@${input.author} te mencionó: «${clip(input.body)}»`;
  return [
    {
      userId: input.userId,
      type: 'COMMUNITY_MENTION',
      channels: COMMUNITY_CHANNELS,
      mandatory: false,
      urgent: false,
      push: { title: 'Te mencionaron', body },
      detail: { title: 'Te mencionaron', body },
      resource: { type: 'post', id: input.postId },
    },
  ];
}

/**
 * Me gusta agrupados: como mucho un aviso por publicación (o comentario) y hora, con el total
 * ("A @ana y 4 personas más les gusta…").
 */
export function planCommunityLike(input: {
  userIds: string[];
  postId: string;
  liker: string;
  others: number;
  onComment: boolean;
  dedupeKey: string;
}): PlannedNotification[] {
  const what = input.onComment ? 'tu comentario' : 'tu publicación';
  const body =
    input.others > 0
      ? `A @${input.liker} y ${input.others} ${input.others === 1 ? 'persona' : 'personas'} más les gusta ${what}.`
      : `A @${input.liker} le gusta ${what}.`;
  return input.userIds.map((userId) => ({
    userId,
    type: 'COMMUNITY_LIKE' as const,
    channels: COMMUNITY_CHANNELS,
    mandatory: false,
    urgent: false,
    push: { title: 'Me gusta', body },
    detail: { title: 'Me gusta', body },
    resource: { type: 'post' as const, id: input.postId },
    dedupeKey: input.dedupeKey,
  }));
}

/** A los seguidores: publicación nueva de una barbería o barbero que siguen. */
export function planCommunityNewPost(input: {
  userIds: string[];
  postId: string;
  authorName: string;
  type: string;
}): PlannedNotification[] {
  const body = `${input.authorName} publicó ${TYPE_TEXT[input.type] ?? 'algo nuevo'}.`;
  return input.userIds.map((userId) => ({
    userId,
    type: 'COMMUNITY_NEW_POST' as const,
    channels: COMMUNITY_CHANNELS,
    mandatory: false,
    urgent: false,
    push: { title: input.authorName, body },
    detail: { title: 'Nueva publicación', body },
    resource: { type: 'post' as const, id: input.postId },
  }));
}
