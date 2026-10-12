import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { AuditService } from '../../../common/audit/audit.service';
import type { AuthUser } from '../../../common/auth/auth-user';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { EncryptedField, OneTimeCodePurpose } from '../../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import type { Prisma } from '../../../generated/prisma/client';
import { UsersService } from '../../users/users.service';
import { AuthService } from '../auth.service';
import type { AuthTokensDto } from '../dto/auth.dto';
import { SessionsService } from '../sessions.service';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp';

const RECOVERY_CODES = 10;
const MAX_FAILURES = 5;
const LOCK_SECONDS = 15 * 60;
/** Sin 0/O/1/I/L para que se lean sin dudas. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const STAFF_ROLES = new Set(['SUPPORT', 'ADMIN']);
export const isStaff = (roles: readonly string[]): boolean => roles.some((r) => STAFF_ROLES.has(r));

export interface MfaStatus {
  enabled: boolean;
  /** El personal (SUPPORT, ADMIN) debe tenerlo para entrar a la administración. */
  required: boolean;
  /** Esta sesión ya pasó el segundo factor. */
  sessionVerified: boolean;
  recoveryCodesRemaining: number;
}

const invalidCode = (): AppException =>
  new AppException(ErrorCode.INVALID_CODE, 'El código no es válido.', HttpStatus.BAD_REQUEST);

/**
 * Verificación en dos pasos del personal (TOTP, RFC 6238). El login no cambia: para entrar a
 * `/admin`, la sesión hace un paso extra (`verify`) que emite una **sesión de personal** (12 h
 * máx., 30 min de inactividad). El secreto se guarda cifrado; los códigos de recuperación, solo
 * como HMAC; un mismo código TOTP no se acepta dos veces. 5 fallos bloquean 15 min.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly auth: AuthService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async status(user: AuthUser): Promise<MfaStatus> {
    const [mfa, remaining, current] = await Promise.all([
      this.prisma.userMfa.findUnique({ where: { userId: user.id }, select: { enabledAt: true } }),
      this.prisma.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } }),
      // Roles de la base (no del token): un rol recién asignado ya cuenta.
      this.users.findCredentialsById(user.id),
    ]);
    return {
      enabled: !!mfa?.enabledAt,
      required: isStaff(current?.roles ?? []),
      sessionVerified: user.mfa === true,
      recoveryCodesRemaining: mfa?.enabledAt ? remaining : 0,
    };
  }

  /** Genera (o reemplaza) un secreto pendiente y devuelve lo necesario para el QR. */
  async setup(user: AuthUser): Promise<{ secret: string; otpauthUri: string }> {
    await this.assertStaff(user);
    const current = await this.prisma.userMfa.findUnique({ where: { userId: user.id } });
    if (current?.enabledAt) {
      throw new AppException(
        ErrorCode.MFA_ALREADY_ENABLED,
        'La verificación en dos pasos ya está activa.',
        HttpStatus.CONFLICT,
      );
    }
    const secret = newTotpSecret();
    const secretEnc = this.encryption.encrypt(secret, EncryptedField.USER_MFA_SECRET);
    await this.prisma.userMfa.upsert({
      where: { userId: user.id },
      create: { userId: user.id, secretEnc },
      update: { secretEnc, lastUsedStep: null },
    });
    const email = (await this.users.contact(user.id))?.email ?? user.id;
    return { secret, otpauthUri: otpauthUri(secret, email) };
  }

  /** Confirma la activación con un código de la app: activa, crea los códigos y eleva la sesión. */
  async enable(
    user: AuthUser,
    code: string,
    ip: string | null,
  ): Promise<{ recoveryCodes: string[]; tokens: AuthTokensDto }> {
    await this.assertStaff(user);
    await this.assertNotLocked(user.id);
    const mfa = await this.prisma.userMfa.findUnique({ where: { userId: user.id } });
    if (!mfa) {
      throw new AppException(
        ErrorCode.MFA_NOT_ENABLED,
        'Primero genera el código QR.',
        HttpStatus.CONFLICT,
      );
    }
    if (mfa.enabledAt) {
      throw new AppException(
        ErrorCode.MFA_ALREADY_ENABLED,
        'La verificación en dos pasos ya está activa.',
        HttpStatus.CONFLICT,
      );
    }
    const step = await this.checkTotp(user.id, mfa.secretEnc, code, null);
    const recoveryCodes = newRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await tx.userMfa.update({
        where: { userId: user.id },
        data: { enabledAt: new Date(this.clock.now()), lastUsedStep: BigInt(step) },
      });
      await this.replaceRecoveryCodes(tx, user.id, recoveryCodes);
      await this.audit.record(
        { actorId: user.id, action: 'mfa.enabled', entityType: 'user', entityId: user.id, ip },
        tx,
      );
    });
    return { recoveryCodes, tokens: await this.elevate(user, ip, 'totp') };
  }

  /**
   * Paso extra para la administración: con un código TOTP (o uno de recuperación) emite una
   * sesión de personal nueva. La sesión actual sigue igual (por ejemplo, la de la app).
   */
  async verify(
    user: AuthUser,
    input: { code?: string; recoveryCode?: string },
    ip: string | null,
  ): Promise<AuthTokensDto> {
    await this.assertStaff(user);
    await this.assertNotLocked(user.id);
    const mfa = await this.prisma.userMfa.findUnique({ where: { userId: user.id } });
    if (!mfa?.enabledAt) {
      throw new AppException(
        ErrorCode.MFA_NOT_ENABLED,
        'Activa la verificación en dos pasos para entrar a la administración.',
        HttpStatus.CONFLICT,
      );
    }
    if (input.recoveryCode) {
      await this.useRecoveryCode(user.id, input.recoveryCode, ip);
      return this.elevate(user, ip, 'recovery');
    }
    const step = await this.checkTotp(
      user.id,
      mfa.secretEnc,
      input.code ?? '',
      mfa.lastUsedStep === null ? null : Number(mfa.lastUsedStep),
    );
    // Condicional: dos verificaciones simultáneas con el mismo código, solo una gana.
    const { count } = await this.prisma.userMfa.updateMany({
      where: {
        userId: user.id,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }],
      },
      data: { lastUsedStep: BigInt(step) },
    });
    if (count === 0) throw invalidCode();
    return this.elevate(user, ip, 'totp');
  }

  /** Códigos de recuperación nuevos (invalida los anteriores); exige un código TOTP. */
  async regenerateRecoveryCodes(
    user: AuthUser,
    code: string,
    ip: string | null,
  ): Promise<string[]> {
    await this.verifyOnly(user, code);
    const recoveryCodes = newRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await this.replaceRecoveryCodes(tx, user.id, recoveryCodes);
      await this.audit.record(
        {
          actorId: user.id,
          action: 'mfa.recovery_codes_regenerated',
          entityType: 'user',
          entityId: user.id,
          ip,
        },
        tx,
      );
    });
    return recoveryCodes;
  }

  /**
   * ADMIN, para quien perdió el teléfono y los códigos: borra el segundo factor y cierra sus
   * sesiones. Deberá activarlo de nuevo para entrar a la administración.
   */
  async resetFor(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.userMfa.deleteMany({ where: { userId } });
    return this.sessions.revokeAllForUser(userId, tx);
  }

  // ───────────── Internos ─────────────

  private async verifyOnly(user: AuthUser, code: string): Promise<void> {
    await this.assertNotLocked(user.id);
    const mfa = await this.prisma.userMfa.findUnique({ where: { userId: user.id } });
    if (!mfa?.enabledAt) {
      throw new AppException(
        ErrorCode.MFA_NOT_ENABLED,
        'La verificación en dos pasos no está activa.',
        HttpStatus.CONFLICT,
      );
    }
    const step = await this.checkTotp(
      user.id,
      mfa.secretEnc,
      code,
      mfa.lastUsedStep === null ? null : Number(mfa.lastUsedStep),
    );
    await this.prisma.userMfa.update({
      where: { userId: user.id },
      data: { lastUsedStep: BigInt(step) },
    });
  }

  private async assertStaff(user: AuthUser): Promise<void> {
    // Roles leídos de la base (no del token): quitar el rol corta el acceso al momento.
    const current = await this.users.findCredentialsById(user.id);
    if (!current || current.status !== 'ACTIVE' || !isStaff(current.roles)) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'La verificación en dos pasos es solo para el personal de Charles.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async checkTotp(
    userId: string,
    secretEnc: string,
    code: string,
    afterStep: number | null,
  ): Promise<number> {
    const secret = this.encryption.decrypt(secretEnc, EncryptedField.USER_MFA_SECRET);
    const step = verifyTotp(secret, code.trim(), this.clock.now(), afterStep);
    if (step === null) {
      await this.recordFailure(userId);
      throw invalidCode();
    }
    await this.redis.del(this.failKey(userId));
    return step;
  }

  private async useRecoveryCode(userId: string, raw: string, ip: string | null): Promise<void> {
    const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const codeHash = this.encryption.oneTimeCodeHash(
      normalized,
      OneTimeCodePurpose.MFA_RECOVERY,
      userId,
    );
    const { count } = await this.prisma.mfaRecoveryCode.updateMany({
      where: { userId, codeHash, usedAt: null },
      data: { usedAt: new Date(this.clock.now()) },
    });
    if (count === 0) {
      await this.recordFailure(userId);
      throw invalidCode();
    }
    await this.redis.del(this.failKey(userId));
    await this.audit.record({
      actorId: userId,
      action: 'mfa.recovery_code_used',
      entityType: 'user',
      entityId: userId,
      ip,
    });
  }

  private async replaceRecoveryCodes(
    tx: Prisma.TransactionClient,
    userId: string,
    codes: string[],
  ): Promise<void> {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((code) => ({
        userId,
        codeHash: this.encryption.oneTimeCodeHash(
          code.replace(/-/g, ''),
          OneTimeCodePurpose.MFA_RECOVERY,
          userId,
        ),
      })),
    });
  }

  /** Sesión de personal nueva (12 h máx., 30 min de inactividad). */
  private async elevate(
    user: AuthUser,
    ip: string | null,
    method: 'totp' | 'recovery',
  ): Promise<AuthTokensDto> {
    const credentials = await this.users.findCredentialsById(user.id);
    if (!credentials) throw invalidCode();
    const session = await this.sessions.create(user.id, { name: 'Administración' }, { mfa: true });
    await this.audit.record({
      actorId: user.id,
      action: 'auth.mfa_verified',
      entityType: 'session',
      entityId: session.sessionId,
      ip,
      changes: { method },
    });
    return this.auth.buildTokens(
      credentials,
      session.sessionId,
      session.refreshToken,
      session.expiresAt,
      true,
    );
  }

  private failKey(userId: string): string {
    return `auth:mfa-fail:${userId}`;
  }

  private async recordFailure(userId: string): Promise<void> {
    const key = this.failKey(userId);
    const [[, count]] = (await this.redis.multi().incr(key).expire(key, LOCK_SECONDS).exec()) as [
      [Error | null, number],
      [Error | null, number],
    ];
    if (count >= MAX_FAILURES) {
      await this.audit.record({
        actorId: userId,
        action: 'mfa.locked',
        entityType: 'user',
        entityId: userId,
      });
    }
  }

  private async assertNotLocked(userId: string): Promise<void> {
    const count = Number((await this.redis.get(this.failKey(userId))) ?? 0);
    if (count >= MAX_FAILURES) {
      throw new AppException(
        ErrorCode.MFA_LOCKED,
        'Demasiados códigos incorrectos. Espera 15 minutos e inténtalo de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/** 10 códigos `XXXX-XXXX` (unos 40 bits cada uno). */
function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES }, () => {
    const bytes = randomBytes(8);
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}
