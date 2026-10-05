import { randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { OneTimeCodePurpose } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

/** CLAUDE.md §4.1: código de 6 dígitos, 15 minutos, un solo uso, inválido tras 5 fallos. */
export const ONE_TIME_CODE_POLICY = {
  digits: 6,
  ttlMinutes: 15,
  maxAttempts: 5,
} as const;

export type CodePurpose = 'PASSWORD_RESET' | 'EMAIL_VERIFICATION';

export type CodeCheck = 'valid' | 'invalid';

interface CodeRow {
  id: string;
  hash: Uint8Array;
}

/**
 * Códigos de un solo uso para recuperación de acceso y verificación de correo.
 * Solo se guarda su HMAC (ligado al usuario y al propósito); el código en claro solo viaja por correo.
 */
@Injectable()
export class OneTimeCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /** Genera un código nuevo e invalida los anteriores aún vigentes del mismo propósito. */
  async issue(purpose: CodePurpose, userId: string): Promise<string> {
    const code = randomInt(0, 10 ** ONE_TIME_CODE_POLICY.digits)
      .toString()
      .padStart(ONE_TIME_CODE_POLICY.digits, '0');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ONE_TIME_CODE_POLICY.ttlMinutes * 60_000);
    const hash = this.hash(purpose, userId, code);

    await this.prisma.$transaction(async (tx) => {
      if (purpose === 'PASSWORD_RESET') {
        await tx.passwordResetToken.updateMany({
          where: { userId, usedAt: null, expiresAt: { gt: now } },
          data: { expiresAt: now },
        });
        await tx.passwordResetToken.create({ data: { userId, tokenHash: hash, expiresAt } });
      } else {
        await tx.emailVerificationCode.updateMany({
          where: { userId, usedAt: null, expiresAt: { gt: now } },
          data: { expiresAt: now },
        });
        await tx.emailVerificationCode.create({ data: { userId, codeHash: hash, expiresAt } });
      }
    });
    return code;
  }

  /**
   * Comprueba y consume el código. Un fallo suma un intento; al quinto el código queda inválido.
   * `onValid` se ejecuta en la misma transacción que consume el código.
   */
  async consume(
    purpose: CodePurpose,
    userId: string,
    code: string,
    onValid?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<CodeCheck> {
    const active = await this.findActive(purpose, userId);
    if (!active) return 'invalid';

    const expected = Buffer.from(active.hash);
    const received = this.hash(purpose, userId, code);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      await this.addFailedAttempt(purpose, active.id);
      return 'invalid';
    }

    return this.prisma.$transaction(async (tx) => {
      const where = {
        id: active.id,
        usedAt: null,
        attempts: { lt: ONE_TIME_CODE_POLICY.maxAttempts },
      };
      const data = { usedAt: new Date() };
      const { count } =
        purpose === 'PASSWORD_RESET'
          ? await tx.passwordResetToken.updateMany({ where, data })
          : await tx.emailVerificationCode.updateMany({ where, data });
      if (count === 0) return 'invalid';
      await onValid?.(tx);
      return 'valid';
    });
  }

  private async findActive(purpose: CodePurpose, userId: string): Promise<CodeRow | null> {
    const where = {
      userId,
      usedAt: null,
      expiresAt: { gt: new Date() },
      attempts: { lt: ONE_TIME_CODE_POLICY.maxAttempts },
    };
    const orderBy = { createdAt: 'desc' as const };
    if (purpose === 'PASSWORD_RESET') {
      const row = await this.prisma.passwordResetToken.findFirst({ where, orderBy });
      return row && { id: row.id, hash: row.tokenHash };
    }
    const row = await this.prisma.emailVerificationCode.findFirst({ where, orderBy });
    return row && { id: row.id, hash: row.codeHash };
  }

  private async addFailedAttempt(purpose: CodePurpose, id: string): Promise<void> {
    const where = { id, attempts: { lt: ONE_TIME_CODE_POLICY.maxAttempts } };
    const data = { attempts: { increment: 1 } };
    if (purpose === 'PASSWORD_RESET')
      await this.prisma.passwordResetToken.updateMany({ where, data });
    else await this.prisma.emailVerificationCode.updateMany({ where, data });
  }

  private hash(purpose: CodePurpose, userId: string, code: string): Buffer<ArrayBuffer> {
    return this.encryption.oneTimeCodeHash(code, OneTimeCodePurpose[purpose], userId);
  }
}
