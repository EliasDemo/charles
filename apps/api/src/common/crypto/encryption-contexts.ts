/**
 * Contextos (AAD) del cifrado de campos y separadores de dominio de los índices ciegos.
 *
 * ⚠️ Son constantes ESTABLES: nunca se modifican ni se reutilizan para otro campo.
 * No derivan del nombre real de tablas o columnas, para que un renombrado futuro
 * no impida descifrar los datos existentes (CLAUDE.md §6.2).
 * Para un campo nuevo, agrega una constante nueva.
 */
export const EncryptedField = {
  USER_EMAIL: 'charles/user.email/v1',
  USER_PHONE: 'charles/user.phone/v1',
  USER_DOCUMENT_NUMBER: 'charles/user.document-number/v1',
  USER_BIRTH_DATE: 'charles/user.birth-date/v1',
  BARBER_PHONE: 'charles/barber.phone/v1',
  TICKET_MESSAGE_BODY: 'charles/ticket-message.body/v1',
  SPONSOR_CONTACT: 'charles/sponsor.contact/v1',
} as const;

export type EncryptedField = (typeof EncryptedField)[keyof typeof EncryptedField];

/** Tipos de índice ciego: cada uno con su normalización y su separador de dominio estable. */
export const BlindIndexKind = {
  EMAIL: 'charles/blind-index/email/v1',
  PHONE: 'charles/blind-index/phone/v1',
  DOCUMENT: 'charles/blind-index/document/v1',
} as const;

export type BlindIndexKind = (typeof BlindIndexKind)[keyof typeof BlindIndexKind];

/** Separadores de dominio estables para el HMAC de códigos de un solo uso (OTP). */
export const OneTimeCodePurpose = {
  PASSWORD_RESET: 'charles/otp/password-reset/v1',
  EMAIL_VERIFICATION: 'charles/otp/email-verification/v1',
  BARBERSHOP_INVITATION: 'charles/otp/barbershop-invitation/v1',
} as const;

export type OneTimeCodePurpose = (typeof OneTimeCodePurpose)[keyof typeof OneTimeCodePurpose];
