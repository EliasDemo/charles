import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-user';
import { PasswordHasher } from '../../common/crypto/password-hasher';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { UsersService } from '../users/users.service';
import type { AcceptedResponseDto, PasswordResetConfirmDto } from './dto/auth.dto';
import { LoginAttemptsService } from './login-attempts.service';
import { AuthMailProducer } from './mail/auth-mail.producer';
import { OneTimeCodesService } from './one-time-codes.service';
import type { RequestContext } from './auth.service';
import { SessionsService } from './sessions.service';

/** Respuesta única de la solicitud de recuperación, exista o no la cuenta (CLAUDE.md §6.3). */
export const PASSWORD_RESET_ACCEPTED: AcceptedResponseDto = {
  message: 'Si el correo corresponde a una cuenta, te enviamos un código para recuperar el acceso.',
};

const invalidCode = (): AppException =>
  new AppException(
    ErrorCode.INVALID_CODE,
    'El código no es válido o expiró. Solicita uno nuevo.',
    HttpStatus.BAD_REQUEST,
  );

/**
 * RF-AUT-004 (recuperación de acceso) y verificación de correo. Los intentos fallidos de código
 * cuentan para el bloqueo por cuenta e IP, igual que los de inicio de sesión.
 */
@Injectable()
export class AccountRecoveryService {
  constructor(
    private readonly users: UsersService,
    private readonly codes: OneTimeCodesService,
    private readonly attempts: LoginAttemptsService,
    private readonly sessions: SessionsService,
    private readonly mail: AuthMailProducer,
    private readonly audit: AuditService,
  ) {}

  /** El trabajo (buscar la cuenta, generar el código y enviarlo) ocurre fuera de la petición. */
  async requestPasswordReset(email: string): Promise<AcceptedResponseDto> {
    await this.mail.enqueue({
      type: 'password-reset',
      emailHashHex: this.users.emailHash(email).toString('hex'),
    });
    return PASSWORD_RESET_ACCEPTED;
  }

  async confirmPasswordReset(dto: PasswordResetConfirmDto, ctx: RequestContext): Promise<void> {
    const emailHash = this.users.emailHash(dto.email);
    const subject = { accountKey: emailHash.toString('hex'), ip: ctx.ip };
    await this.attempts.assertNotLocked(subject);

    const user = await this.users.findCredentialsByEmailHash(emailHash);
    // Se calcula siempre, para no revelar por tiempo si la cuenta existe.
    const newPasswordHash = await PasswordHasher.hash(dto.newPassword);
    const usable = user && !user.isDeleted && user.status === 'ACTIVE';

    let revokedSessions: string[] = [];
    const result = usable
      ? await this.codes.consume('PASSWORD_RESET', user.id, dto.code, async (tx) => {
          await this.users.updatePasswordHash(user.id, newPasswordHash, tx);
          revokedSessions = await this.sessions.revokeAllForUser(user.id, tx);
          await this.audit.record(
            {
              actorId: user.id,
              action: 'auth.password_reset',
              entityType: 'user',
              entityId: user.id,
              ip: ctx.ip,
            },
            tx,
          );
        })
      : 'invalid';

    if (result !== 'valid' || !user) {
      await this.attempts.recordFailure(subject);
      throw invalidCode();
    }

    await this.attempts.recordSuccess(subject.accountKey);
    await this.sessions.markRevoked(revokedSessions);
    await this.mail.enqueue({ type: 'password-changed', userId: user.id });
  }

  async requestEmailVerification(user: AuthUser): Promise<AcceptedResponseDto> {
    const credentials = await this.users.findCredentialsById(user.id);
    if (credentials && !credentials.emailVerified) {
      await this.mail.enqueue({ type: 'email-verification', userId: user.id });
    }
    return { message: 'Si tu correo aún no está verificado, te enviamos un código nuevo.' };
  }

  async confirmEmailVerification(user: AuthUser, code: string, ctx: RequestContext): Promise<void> {
    const emailHash = await this.users.emailHashOf(user.id);
    if (!emailHash) throw invalidCode();
    const subject = { accountKey: emailHash.toString('hex'), ip: ctx.ip };
    await this.attempts.assertNotLocked(subject);

    const result = await this.codes.consume('EMAIL_VERIFICATION', user.id, code, async (tx) => {
      await this.users.markEmailVerified(user.id, tx);
      await this.audit.record(
        {
          actorId: user.id,
          action: 'auth.email_verified',
          entityType: 'user',
          entityId: user.id,
          ip: ctx.ip,
        },
        tx,
      );
    });
    if (result !== 'valid') {
      await this.attempts.recordFailure(subject);
      throw invalidCode();
    }
  }
}
