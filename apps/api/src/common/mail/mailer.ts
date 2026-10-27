export const MAILER = Symbol('MAILER');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Categoría estable para métricas y pruebas (por ejemplo `password-reset`). */
  category: string;
}

/** Envío de correos: `FakeMailer` (desarrollo y pruebas) o `ResendMailer` (producción). */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
