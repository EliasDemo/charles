import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/env.validation';
import type { Mailer, MailMessage } from './mailer';

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15_000;

/** Fallo del proveedor de correo. Los procesos que envían correos reintentan con espera. */
export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

/**
 * Correo real con la API HTTP de Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Sin dependencias: `fetch` con tiempo límite. Nunca registra el destinatario ni el contenido.
 * Requiere un dominio verificado en Resend para el remitente (`MAIL_FROM`).
 */
@Injectable()
export class ResendMailer implements Mailer {
  private readonly logger = new Logger(ResendMailer.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(message: MailMessage): Promise<void> {
    const { resendApiKey, from } = this.config.mail;
    if (!resendApiKey || !from) {
      throw new MailDeliveryError('Correo sin configurar: RESEND_API_KEY y MAIL_FROM', null);
    }
    let res: Response;
    try {
      res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          tags: [{ name: 'category', value: message.category.replace(/[^A-Za-z0-9_-]/g, '_') }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new MailDeliveryError(
        `El proveedor de correo no respondió (${(error as Error).name})`,
        null,
      );
    }
    if (!res.ok) {
      this.logger.warn(
        { status: res.status, category: message.category },
        'Resend rechazó el correo',
      );
      throw new MailDeliveryError(`El proveedor de correo respondió ${res.status}`, res.status);
    }
    this.logger.log({ category: message.category }, 'Correo enviado');
  }
}
