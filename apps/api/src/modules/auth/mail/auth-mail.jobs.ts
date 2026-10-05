export const AUTH_MAIL_QUEUE = 'auth-mail';

/**
 * Trabajos de correo de autenticación. Nunca contienen datos personales en claro:
 * solo IDs o el índice ciego del correo (hex). El worker resuelve el destinatario.
 */
export type AuthMailJob =
  | { type: 'registration'; userId: string; isNewAccount: boolean }
  | { type: 'email-verification'; userId: string }
  | { type: 'password-reset'; emailHashHex: string }
  | { type: 'password-changed'; userId: string }
  | { type: 'account-locked'; emailHashHex: string; lockMinutes: number };
