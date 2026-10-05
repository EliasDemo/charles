import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { MAILER, type Mailer } from '../../../common/mail/mailer';
import { UsersService } from '../../users/users.service';
import { OneTimeCodesService } from '../one-time-codes.service';
import { AUTH_MAIL_QUEUE, type AuthMailJob } from './auth-mail.jobs';
import { AuthMailTemplates } from './auth-mail.templates';

/** Resuelve el destinatario, genera los códigos y envía los correos de autenticación. */
@Processor(AUTH_MAIL_QUEUE)
export class AuthMailProcessor extends WorkerHost {
  private readonly logger = new Logger(AuthMailProcessor.name);

  constructor(
    private readonly users: UsersService,
    private readonly codes: OneTimeCodesService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {
    super();
  }

  async process(job: Job<AuthMailJob>): Promise<void> {
    const data = job.data;
    switch (data.type) {
      case 'registration': {
        const to = await this.users.contactEmail(data.userId);
        if (!to) return;
        if (data.isNewAccount) {
          const code = await this.codes.issue('EMAIL_VERIFICATION', data.userId);
          await this.mailer.send({ to, ...AuthMailTemplates.welcome(code) });
        } else {
          await this.mailer.send({ to, ...AuthMailTemplates.registrationAttempt() });
        }
        return;
      }
      case 'email-verification': {
        const to = await this.users.contactEmail(data.userId);
        if (!to) return;
        const code = await this.codes.issue('EMAIL_VERIFICATION', data.userId);
        await this.mailer.send({ to, ...AuthMailTemplates.emailVerification(code) });
        return;
      }
      case 'password-reset': {
        const user = await this.activeUserByEmailHash(data.emailHashHex);
        if (!user) return; // Cuenta inexistente: no se envía nada (la API respondió igual).
        const code = await this.codes.issue('PASSWORD_RESET', user.id);
        await this.mailer.send({ to: user.email, ...AuthMailTemplates.passwordReset(code) });
        return;
      }
      case 'password-changed': {
        const to = await this.users.contactEmail(data.userId);
        if (to) await this.mailer.send({ to, ...AuthMailTemplates.passwordChanged() });
        return;
      }
      case 'account-locked': {
        const user = await this.activeUserByEmailHash(data.emailHashHex);
        if (user) {
          await this.mailer.send({
            to: user.email,
            ...AuthMailTemplates.accountLocked(data.lockMinutes),
          });
        }
        return;
      }
      default: {
        const unknown: never = data;
        this.logger.error({ job: job.name, unknown }, 'Trabajo de correo desconocido');
      }
    }
  }

  private async activeUserByEmailHash(
    emailHashHex: string,
  ): Promise<{ id: string; email: string } | null> {
    const credentials = await this.users.findCredentialsByEmailHash(
      Buffer.from(Buffer.from(emailHashHex, 'hex')),
    );
    if (!credentials || credentials.isDeleted || credentials.status !== 'ACTIVE') return null;
    const email = await this.users.contactEmail(credentials.id);
    return email ? { id: credentials.id, email } : null;
  }
}
