export const MAILER = Symbol('MAILER');

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Categoría estable para métricas y pruebas (por ejemplo `password-reset`). */
  category: string;
}

/**
 * Envío de correos. Hoy solo existe `FakeMailer`; el proveedor real se elige en la Fase 10
 * y se implementa detrás de esta misma interfaz.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
