import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { dbErrorInfo, isExclusionViolation } from '../common/errors/db-error';
import { BarbersService } from '../modules/barbers/barbers.service';
import { BookingStateMachine } from '../modules/bookings/booking-state-machine';
import { PaymentsService } from '../modules/payments/payments.service';
import { UsersService } from '../modules/users/users.service';
import { AuditService } from '../common/audit/audit.service';
import { CLOCK, type Clock } from '../common/clock/clock';
import { APP_CONFIG } from '../common/config/app-config.token';
import { type AppConfig, MailerDriver } from '../common/config/env.validation';
import { FakeMailer, type StoredMail } from '../common/mail/fake-mailer';
import { PrismaService } from '../common/prisma/prisma.service';
import { FAKE_SIGNATURE_HEADER, FakeGateway } from '../modules/payments/fake-gateway';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../modules/payments/payment-gateway';
import { FAKE_PROVIDER } from '../modules/payments/payments-provider.check';
import { WebhooksService } from '../modules/payments/webhooks.service';
import { SettingKey, SettingsService } from '../modules/settings/settings.service';

/**
 * Herramientas de consola **solo para desarrollo** (nunca endpoints): `dev:pay` y `dev:mail`.
 * Nunca funcionan con NODE_ENV=production; `dev:pay` exige la pasarela simulada y `dev:mail` el
 * correo simulado. Las comprobaciones se repiten aquí (no solo en el script) para que nadie pueda
 * llamarlas por otro camino.
 */
export class DevToolError extends Error {}

/** Antes de arrancar Nest: rechaza producción con lo que diga el entorno. */
export function assertNotProduction(nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') {
    throw new DevToolError('Herramienta de desarrollo: no se ejecuta con NODE_ENV=production.');
  }
}

/**
 * `dev:pay`: simula que el cliente pagó (o que se rechazó) y aplica el resultado **por el mismo
 * camino que el aviso real**: un webhook firmado por la pasarela simulada que recibe
 * `WebhooksService` (firma, coherencia, `payment_events`, máquina de estados, reembolso de pagos
 * huérfanos). Queda en audit_log.
 */
export async function devPay(
  app: INestApplicationContext,
  bookingId: string,
  outcome: 'SUCCEEDED' | 'REJECTED',
): Promise<{ paymentId: string; bookingStatus: string; duplicate: boolean }> {
  const config = app.get<AppConfig>(APP_CONFIG);
  assertNotProduction(config.isProduction ? 'production' : config.nodeEnv);
  const gateway = app.get<PaymentGateway>(PAYMENT_GATEWAY);
  const configured = await app.get(SettingsService).get(SettingKey.PAYMENTS_PROVIDER);
  if (gateway.provider !== FAKE_PROVIDER || (configured !== null && configured !== FAKE_PROVIDER)) {
    throw new DevToolError(
      'dev:pay solo funciona con la pasarela simulada (payments.provider = FAKE).',
    );
  }

  const prisma = app.get(PrismaService);
  const payment = await prisma.payment.findFirst({
    where: { bookingId, status: 'PENDING', provider: FAKE_PROVIDER },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) {
    throw new DevToolError(
      'La reserva no existe o no tiene un pago pendiente de la pasarela simulada.',
    );
  }
  const fake = app.get(FakeGateway);
  // Registra el importe en la pasarela simulada (como si la app hubiera iniciado el pago).
  await fake.createPayment({
    paymentId: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    idempotencyKey: payment.idempotencyKey,
    description: 'dev:pay',
  });
  const { rawBody, signature } = fake.settlePayment(payment.id, outcome);
  const receipt = await app
    .get(WebhooksService)
    .receive(
      fake.provider,
      { rawBody: Buffer.from(rawBody), headers: { [FAKE_SIGNATURE_HEADER]: signature } },
      '127.0.0.1',
    );
  await app.get(AuditService).record({
    action: 'dev.payment_simulated',
    entityType: 'payment',
    entityId: payment.id,
    changes: { bookingId, outcome, tool: 'dev:pay' },
  });
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { status: true },
  });
  return { paymentId: payment.id, bookingStatus: booking.status, duplicate: receipt.duplicate };
}

export interface DevBookingOptions {
  /** Correo de la cuenta del barbero (perfil activo). */
  barberEmail: string;
  /** Correo del cliente; por defecto, el cliente del seed. */
  clientEmail?: string;
  /** Inicio relativo a ahora, en minutos (negativo = ya empezó). */
  startOffsetMinutes: number;
  serviceId?: string;
  /** Confirmar el pago por el mismo camino que `dev:pay`. */
  confirm?: boolean;
  /** Además marcarla ATTENDED (para probar la corrección dentro de las 48 h). */
  attended?: boolean;
}

export const SEED_CLIENT_EMAIL = 'cliente.demo@example.com';

/**
 * `dev:booking`: crea una reserva a una hora **relativa a ahora** (también pasada: −20 min, −47 h)
 * para probar las ventanas de asistencia, no-show y corrección. Solo desarrollo y pasarela simulada,
 * y queda auditada.
 *
 * No pasa por la disponibilidad (que nunca acepta horas pasadas): inserta la reserva en una
 * transacción con el mismo registro que el flujo normal (historial, outbox, pago pendiente), y la
 * restricción de la base contra reservas solapadas sigue aplicándose. Con `confirm`, el pago se
 * confirma por el webhook simulado, como `dev:pay`.
 *
 * Con una pasarela real (Mercado Pago o Izipay en modo de prueba) solo crea la reserva pendiente
 * e **inicia el pago**: devuelve el enlace (`paymentUrl`) para pagar en el navegador.
 */
export async function devBooking(
  app: INestApplicationContext,
  options: DevBookingOptions,
): Promise<{
  bookingId: string;
  startAt: Date;
  status: string;
  barbershopId: string;
  paymentUrl: string | null;
}> {
  const config = app.get<AppConfig>(APP_CONFIG);
  assertNotProduction(config.isProduction ? 'production' : config.nodeEnv);
  const gateway = app.get<PaymentGateway>(PAYMENT_GATEWAY);
  const simulated = gateway.provider === FAKE_PROVIDER;
  if (!simulated && (options.confirm || options.attended)) {
    throw new DevToolError(
      'Con una pasarela real, --confirm y --attended no aplican: paga con el enlace que se imprime.',
    );
  }
  const users = app.get(UsersService);
  const prisma = app.get(PrismaService);
  const now = app.get<Clock>(CLOCK).now();
  const findUser = async (email: string, label: string) => {
    const id = await users.findIdByEmailHash(users.emailHash(email));
    if (!id) throw new DevToolError(`No existe una cuenta ${label} con ese correo.`);
    return id;
  };
  const barberUserId = await findUser(options.barberEmail, 'de barbero');
  const [profile] = await app.get(BarbersService).activeProfilesOfUser(barberUserId);
  if (!profile) throw new DevToolError('Esa cuenta no tiene un perfil de barbero activo.');
  const clientId = await findUser(options.clientEmail ?? SEED_CLIENT_EMAIL, 'de cliente');

  const link = await prisma.barberService.findFirst({
    where: {
      barberId: profile.id,
      ...(options.serviceId ? { serviceId: options.serviceId } : {}),
      service: { deletedAt: null, isAvailable: true },
    },
    select: { service: true },
    orderBy: { serviceId: 'asc' },
  });
  if (!link) throw new DevToolError('El barbero no tiene ese servicio (o ningún servicio activo).');
  const service = link.service;

  // Al minuto, para que las horas sean legibles.
  const startAt = Math.floor((now + options.startOffsetMinutes * 60_000) / 60_000) * 60_000;
  const endAt = startAt + service.durationMinutes * 60_000;
  const ttlMinutes = await app
    .get(SettingsService)
    .positiveInt(SettingKey.PENDING_PAYMENT_TTL_MINUTES, 10);

  let bookingId: string;
  let paymentId = '';
  try {
    bookingId = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          clientId,
          barbershopId: profile.barbershopId,
          barberId: profile.id,
          serviceId: service.id,
          startAt: new Date(startAt),
          endAt: new Date(endAt),
          status: 'PENDING_PAYMENT',
          barberChosenByClient: true,
          serviceNameSnapshot: service.name,
          durationMinutesSnapshot: service.durationMinutes,
          subtotalAmount: service.priceAmount,
          totalAmount: service.priceAmount,
          currency: service.currency,
          expiresAt: new Date(now + ttlMinutes * 60_000),
          idempotencyKey: randomUUID(),
          metadata: { source: 'dev:booking' },
          priceLines: {
            create: [
              {
                type: 'SERVICE',
                description: service.name,
                amount: service.priceAmount,
                sourceType: 'service',
                sourceId: service.id,
              },
            ],
          },
        },
        select: { id: true },
      });
      await app
        .get(BookingStateMachine)
        .recordCreation(
          tx,
          { id: booking.id, barbershopId: profile.barbershopId, barberId: profile.id, clientId },
          { userId: clientId, role: 'CLIENT' },
        );
      paymentId = await app.get(PaymentsService).createPendingInTx(tx, {
        id: booking.id,
        barbershopId: profile.barbershopId,
        totalAmount: service.priceAmount,
        commissionAmount: 0,
        currency: service.currency,
      });
      return booking.id;
    });
  } catch (error) {
    if (isExclusionViolation(dbErrorInfo(error))) {
      throw new DevToolError('El barbero ya tiene una reserva que se cruza con ese horario.');
    }
    throw error;
  }

  if (options.confirm || options.attended) await devPay(app, bookingId, 'SUCCEEDED');
  // Pasarela real: se inicia el pago (fuera de la transacción) y se devuelve el enlace.
  const paymentUrl = simulated
    ? null
    : ((await app.get(PaymentsService).startAfterCreation(paymentId, service.name)).clientAction
        ?.data.paymentUrl ?? null);
  if (options.attended) {
    await prisma.$transaction((tx) =>
      app
        .get(BookingStateMachine)
        .transition(
          tx,
          bookingId,
          'ATTENDED',
          { userId: barberUserId, role: 'BARBERSHOP' },
          'dev:booking',
        ),
    );
  }
  await app.get(AuditService).record({
    action: 'dev.booking_created',
    entityType: 'booking',
    entityId: bookingId,
    changes: {
      tool: 'dev:booking',
      startOffsetMinutes: options.startOffsetMinutes,
      confirm: !!options.confirm,
      attended: !!options.attended,
    },
  });
  const created = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { status: true },
  });
  return {
    bookingId,
    startAt: new Date(startAt),
    status: created.status,
    barbershopId: profile.barbershopId,
    paymentUrl,
  };
}

/** `-20m`, `+2h`, `-47h`, `0` → minutos. */
export function parseOffset(value: string): number {
  const match = /^([+-]?\d+)([mh]?)$/.exec(value.trim());
  if (!match) throw new DevToolError('--start debe ser como -20m, +10m, -2h o -47h.');
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount * 60 : amount;
}

/** `dev:mail`: correos simulados de un destinatario, del más reciente al más antiguo. */
export async function devMail(app: INestApplicationContext, to: string): Promise<StoredMail[]> {
  const config = app.get<AppConfig>(APP_CONFIG);
  assertNotProduction(config.isProduction ? 'production' : config.nodeEnv);
  if (config.mail.driver !== MailerDriver.Fake) {
    throw new DevToolError('dev:mail solo funciona con el correo simulado (MAILER_DRIVER=fake).');
  }
  const wanted = to.trim().toLowerCase();
  const mails = (await app.get(FakeMailer).inbox()).filter((m) => m.to.toLowerCase() === wanted);
  // Sin el correo en la auditoría (dato personal): solo cuántos se leyeron.
  await app.get(AuditService).record({
    action: 'dev.mail_read',
    entityType: 'fake_mailer',
    changes: { messages: mails.length, tool: 'dev:mail' },
  });
  return mails;
}
