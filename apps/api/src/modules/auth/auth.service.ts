import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-user';
import { TokenService } from '../../common/auth/token.service';
import { PasswordHasher } from '../../common/crypto/password-hasher';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { type UserCredentials, UsersService } from '../users/users.service';
import type {
  AcceptedResponseDto,
  AuthTokensDto,
  LoginDto,
  RegisterDto,
  SupportAccessDto,
  TermsDto,
} from './dto/auth.dto';
import { LoginAttemptsService } from './login-attempts.service';
import { AuthMailProducer } from './mail/auth-mail.producer';
import { SessionsService } from './sessions.service';

/** Respuesta única del registro, exista o no el correo (ADR 0003). */
export const REGISTER_ACCEPTED: AcceptedResponseDto = {
  message: 'Recibimos tu solicitud. Revisa tu correo para continuar; luego podrás iniciar sesión.',
};

const invalidCredentials = (): AppException =>
  new AppException(
    ErrorCode.INVALID_CREDENTIALS,
    'El correo o la contraseña no son correctos.',
    HttpStatus.UNAUTHORIZED,
  );

export interface RequestContext {
  ip: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  /** Hash ficticio para igualar el tiempo de respuesta cuando la cuenta no existe. */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly attempts: LoginAttemptsService,
    private readonly mail: AuthMailProducer,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async termsVersion(): Promise<string> {
    return this.settings.termsVersion();
  }

  /** Versión vigente y enlaces públicos a los documentos legales. */
  async terms(): Promise<TermsDto> {
    const [version, termsUrl, privacyUrl] = await Promise.all([
      this.settings.termsVersion(),
      this.settings.get(SettingKey.TERMS_URL),
      this.settings.get(SettingKey.PRIVACY_URL),
    ]);
    return {
      version,
      termsUrl: httpsUrlOrNull(termsUrl),
      privacyUrl: httpsUrlOrNull(privacyUrl),
    };
  }

  /**
   * RF-AUT-001. Siempre responde lo mismo y hace el mismo trabajo costoso (hash Argon2id y un
   * trabajo de correo), exista o no el correo: nueva cuenta → código de verificación;
   * correo existente → aviso a su dueño (ADR 0003).
   */
  async register(dto: RegisterDto, ctx: RequestContext): Promise<AcceptedResponseDto> {
    if (dto.termsVersion !== (await this.settings.termsVersion())) {
      throw new AppException(
        ErrorCode.TERMS_VERSION_OUTDATED,
        'Los términos y condiciones cambiaron. Revísalos y acéptalos nuevamente.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const passwordHash = await PasswordHasher.hash(dto.password);
    const emailHash = this.users.emailHash(dto.email);
    // Correo de una cuenta deshabilitada por soporte que se eliminó: no se registra hasta que
    // venza el bloqueo. La respuesta es idéntica (no revela nada) y no se envía correo.
    if (await this.users.isEmailBlocked(emailHash)) return REGISTER_ACCEPTED;
    const existingId = await this.users.findIdByEmailHash(emailHash);

    const createdId = existingId
      ? null
      : await this.users.createClient(
          {
            fullName: dto.fullName,
            email: dto.email,
            phone: dto.phone ?? null,
            passwordHash,
            termsVersion: dto.termsVersion,
          },
          ctx.ip,
        );

    // `createClient` devuelve null si otro registro simultáneo ganó la carrera.
    const userId =
      createdId ??
      existingId ??
      (await this.users.findIdByEmailHash(this.users.emailHash(dto.email)));
    if (userId) {
      await this.mail.enqueue({ type: 'registration', userId, isNewAccount: createdId !== null });
    }
    return REGISTER_ACCEPTED;
  }

  /** RF-AUT-002. Mensaje genérico ante cualquier fallo de credenciales. */
  async login(dto: LoginDto, ctx: RequestContext): Promise<AuthTokensDto> {
    const user = await this.verifyCredentials(dto, ctx);

    // Contraseña correcta: recién ahora se puede revelar el estado de la cuenta.
    if (user.pendingDeletion) {
      throw new AppException(
        ErrorCode.ACCOUNT_PENDING_DELETION,
        'Tu cuenta está pendiente de eliminación. Usa el acceso limitado para consultarla o cancelarla.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (user.status !== 'ACTIVE') {
      throw new AppException(
        ErrorCode.ACCOUNT_DISABLED,
        'Tu cuenta está deshabilitada. Contacta a soporte para más información.',
        HttpStatus.FORBIDDEN,
      );
    }

    const session = await this.sessions.create(user.id, {
      name: dto.deviceName ?? null,
      userAgent: ctx.userAgent?.slice(0, 200) ?? null,
    });
    return this.buildTokens(user, session.sessionId, session.refreshToken, session.expiresAt);
  }

  /**
   * Acceso limitado, con las mismas comprobaciones que el inicio de sesión (bloqueo por intentos,
   * contraseña) y sin token de renovación:
   * - cuenta pendiente de eliminación → alcance `deletion` (consultar o cancelar la eliminación);
   * - cuenta deshabilitada → alcance `support` (sus tickets y pedir su eliminación).
   * Una cuenta activa usa `login`.
   */
  async supportAccess(dto: LoginDto, ctx: RequestContext): Promise<SupportAccessDto> {
    const user = await this.verifyCredentials(dto, ctx);
    const scope = user.pendingDeletion ? 'deletion' : user.status !== 'ACTIVE' ? 'support' : null;
    if (!scope) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Tu cuenta está activa: inicia sesión normalmente.',
        HttpStatus.CONFLICT,
      );
    }
    const signed = this.tokens.signAccessToken(user, randomUUID(), { restricted: scope });
    await this.audit.record({
      actorId: user.id,
      action: 'auth.support_access',
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
      changes: { scope },
    });
    return {
      tokenType: 'Bearer',
      accessToken: signed.token,
      accessTokenExpiresAt: signed.expiresAt,
      restricted: true,
      scope,
    };
  }

  /** Bloqueo por intentos y contraseña; el estado de la cuenta lo decide quien llama. */
  private async verifyCredentials(
    dto: LoginDto,
    ctx: RequestContext,
  ): Promise<NonNullable<Awaited<ReturnType<UsersService['findCredentialsByEmailHash']>>>> {
    const emailHash = this.users.emailHash(dto.email);
    const subject = { accountKey: emailHash.toString('hex'), ip: ctx.ip };
    await this.attempts.assertNotLocked(subject);

    const user = await this.users.findCredentialsByEmailHash(emailHash);
    const passwordOk = await PasswordHasher.verify(
      user && !user.isDeleted ? user.passwordHash : await this.getDummyHash(),
      dto.password,
    );

    if (!user || user.isDeleted || !passwordOk) {
      const { accountLockSeconds } = await this.attempts.recordFailure(subject);
      if (accountLockSeconds > 0) {
        await this.mail.enqueue({
          type: 'account-locked',
          emailHashHex: subject.accountKey,
          lockMinutes: Math.round(accountLockSeconds / 60),
        });
      }
      throw invalidCredentials();
    }
    await this.attempts.recordSuccess(subject.accountKey);
    return user;
  }

  /** Rota el token de renovación (sesión de 30 días que se renueva con el uso). */
  async refresh(refreshToken: string, ctx: RequestContext): Promise<AuthTokensDto> {
    const rotated = await this.sessions.rotate(refreshToken, ctx.ip);
    const user = await this.users.findCredentialsById(rotated.userId);
    if (!user || user.isDeleted || user.status !== 'ACTIVE' || user.pendingDeletion) {
      await this.sessions.revokeSession(rotated.userId, rotated.sessionId);
      throw new AppException(
        ErrorCode.INVALID_REFRESH_TOKEN,
        'Tu sesión expiró. Inicia sesión nuevamente.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.buildTokens(user, rotated.sessionId, rotated.refreshToken, rotated.expiresAt);
  }

  /** RF-AUT-003: dispositivo actual o todos los dispositivos. */
  async logout(user: AuthUser, allDevices: boolean, ctx: RequestContext): Promise<void> {
    if (!allDevices) {
      await this.sessions.revokeSession(user.id, user.sessionId);
      return;
    }
    const sessionIds = await this.sessions.revokeAllForUser(user.id);
    await this.sessions.markRevoked([...sessionIds, user.sessionId]);
    await this.audit.record({
      actorId: user.id,
      action: 'auth.logout_all_devices',
      entityType: 'user',
      entityId: user.id,
      ip: ctx.ip,
    });
  }

  private buildTokens(
    user: UserCredentials,
    sessionId: string,
    refreshToken: string,
    refreshTokenExpiresAt: Date,
  ): AuthTokensDto {
    const access = this.tokens.signAccessToken(user, sessionId);
    return {
      tokenType: 'Bearer',
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt,
      user: {
        id: user.id,
        fullName: user.fullName,
        roles: user.roles,
        emailVerified: user.emailVerified,
      },
    };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= PasswordHasher.hash(`dummy-${Math.random()}-${Date.now()}`);
    return this.dummyHash;
  }
}

/** Solo URLs https; un valor mal configurado no se envía a la app. */
function httpsUrlOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/\S+$/.test(value) ? value : null;
}
