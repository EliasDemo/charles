import type { INestApplicationContext } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
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
