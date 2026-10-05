import type { MailMessage } from '../../../common/mail/mailer';
import { ONE_TIME_CODE_POLICY } from '../one-time-codes.service';

const SIGNATURE = '\n\n— El equipo de Charles';
const IGNORE = 'Si no fuiste tú, puedes ignorar este mensaje.';

type Template = Omit<MailMessage, 'to'>;

export const AuthMailTemplates = {
  welcome(code: string): Template {
    return {
      category: 'welcome-verification',
      subject: 'Bienvenido a Charles: verifica tu correo',
      text:
        `Tu cuenta en Charles fue creada.\n\nTu código de verificación es: ${code}\n` +
        `Vence en ${ONE_TIME_CODE_POLICY.ttlMinutes} minutos.\n\n${IGNORE}${SIGNATURE}`,
    };
  },

  emailVerification(code: string): Template {
    return {
      category: 'email-verification',
      subject: 'Tu código de verificación de Charles',
      text:
        `Tu código de verificación es: ${code}\n` +
        `Vence en ${ONE_TIME_CODE_POLICY.ttlMinutes} minutos.\n\n${IGNORE}${SIGNATURE}`,
    };
  },

  /** ADR 0003: aviso al dueño del correo cuando alguien intenta registrarse con él. */
  registrationAttempt(): Template {
    return {
      category: 'registration-attempt',
      subject: 'Intento de registro con tu correo en Charles',
      text:
        'Alguien intentó crear una cuenta en Charles con tu correo, que ya está registrado.\n\n' +
        'Si fuiste tú, inicia sesión o usa "Olvidé mi contraseña" para recuperar el acceso.\n' +
        `Si no fuiste tú, no tienes que hacer nada: tu cuenta sigue protegida.${SIGNATURE}`,
    };
  },

  passwordReset(code: string): Template {
    return {
      category: 'password-reset',
      subject: 'Recupera el acceso a tu cuenta de Charles',
      text:
        `Tu código para restablecer la contraseña es: ${code}\n` +
        `Vence en ${ONE_TIME_CODE_POLICY.ttlMinutes} minutos y solo puede usarse una vez.\n\n` +
        `${IGNORE}${SIGNATURE}`,
    };
  },

  passwordChanged(): Template {
    return {
      category: 'password-changed',
      subject: 'Tu contraseña de Charles fue cambiada',
      text:
        'La contraseña de tu cuenta fue cambiada y se cerraron todas tus sesiones.\n\n' +
        `Si no fuiste tú, contacta de inmediato a soporte.${SIGNATURE}`,
    };
  },

  accountLocked(lockMinutes: number): Template {
    return {
      category: 'account-locked',
      subject: 'Bloqueamos temporalmente el acceso a tu cuenta de Charles',
      text:
        `Detectamos varios intentos fallidos de acceso a tu cuenta y la bloqueamos por ${lockMinutes} ` +
        `${lockMinutes === 1 ? 'minuto' : 'minutos'}.\n\n` +
        'Si no fuiste tú, te recomendamos cambiar tu contraseña con "Olvidé mi contraseña".' +
        SIGNATURE,
    };
  },
};
