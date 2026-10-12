import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { AuditService } from '../../common/audit/audit.service';
import { DevicesService } from '../notifications/devices.service';
import { SessionRevocationStore } from '../../common/auth/session-revocation.store';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { AppException } from '../../common/errors/app.exception';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import type { Prisma } from '../../generated/prisma/client';

const REFRESH_TOKEN_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Sesión de personal (con segundo factor): 12 h como máximo y 30 min de inactividad. */
export const STAFF_SESSION = { absoluteMs: 12 * 60 * 60 * 1000, idleMs: 30 * 60 * 1000 } as const;

export interface IssuedRefreshToken {
  refreshToken: string;
  expiresAt: Date;
  sessionId: string;
  /** Sesión de personal con segundo factor. */
  mfa: boolean;
}

/** Atributos de la familia que se conservan al rotar. */
interface SessionKind {
  mfa: boolean;
  absoluteExpiresAt: Date | null;
}

export interface RotatedSession extends IssuedRefreshToken {
  userId: string;
}

/** La rotación la ganó otra petición concurrente con el mismo token. */
class LostRotationRace extends Error {}

const invalidRefreshToken = (): AppException =>
  new AppException(
    ErrorCode.INVALID_REFRESH_TOKEN,
    'Tu sesión expiró. Inicia sesión nuevamente.',
    HttpStatus.UNAUTHORIZED,
  );

/** Token de renovación opaco: el servidor solo guarda su SHA-256 (alta entropía, no requiere HMAC). */
function hashToken(token: string): Buffer<ArrayBuffer> {
  return Buffer.from(createHash('sha256').update(token, 'utf8').digest());
}

/**
 * Sesiones con token de renovación opaco, rotación en cada uso y detección de reutilización
 * (CLAUDE.md §6.3). Una sesión es una familia de tokens (`family_id`), igual al `sid` del JWT.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly revocations: SessionRevocationStore,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly encryption: EncryptionService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly devices: DevicesService,
  ) {}

  async create(
    userId: string,
    deviceInfo?: Prisma.InputJsonValue,
    options: { mfa?: boolean } = {},
  ): Promise<IssuedRefreshToken> {
    const sessionId = randomUUID();
    const kind: SessionKind = options.mfa
      ? { mfa: true, absoluteExpiresAt: new Date(Date.now() + STAFF_SESSION.absoluteMs) }
      : { mfa: false, absoluteExpiresAt: null };
    return this.issue(this.prisma, userId, sessionId, kind, deviceInfo);
  }

  /**
   * Rota el token: el usado queda revocado y apunta a su reemplazo. Si llega un token ya rotado
   * o revocado, se asume robo y se revoca toda la familia, **salvo** dentro de la gracia
   * (`REFRESH_TOKEN_GRACE_SECONDS`, 10 s): si el mismo token se reintenta justo después de rotarse
   * (reintento o carrera de red de la app), se devuelve **el mismo** sucesor, nunca uno distinto.
   */
  async rotate(refreshToken: string, ip: string | null): Promise<RotatedSession> {
    const tokenHash = hashToken(refreshToken);
    const current = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!current) throw invalidRefreshToken();

    if (current.revokedAt) {
      if (current.replacedBy) {
        const replay = await this.graceSuccessor(current);
        if (replay) return replay;
        await this.handleReuse(current.userId, current.familyId, ip);
      }
      throw invalidRefreshToken();
    }
    if (current.expiresAt <= new Date()) throw invalidRefreshToken();

    let rotated: IssuedRefreshToken & { tokenId: string };
    try {
      rotated = await this.prisma.$transaction(async (tx) => {
        const next = await this.issue(
          tx,
          current.userId,
          current.familyId,
          { mfa: current.amr === 'mfa', absoluteExpiresAt: current.absoluteExpiresAt },
          current.deviceInfo ?? undefined,
        );
        // Condicional: si otra petición rotó el mismo token a la vez, solo una gana. La que pierde
        // revierte su transacción (no deja un token huérfano) y recibe el sucesor de la ganadora.
        const { count } = await tx.refreshToken.updateMany({
          where: { id: current.id, revokedAt: null },
          data: { revokedAt: new Date(), replacedBy: next.tokenId },
        });
        if (count === 0) throw new LostRotationRace();
        // Antes del commit: quien pierda la carrera ya encuentra el sucesor al terminar de esperar.
        await this.rememberSuccessor(tokenHash, next);
        return next;
      });
    } catch (error) {
      if (!(error instanceof LostRotationRace)) throw error;
      const winner = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
      const replay = winner ? await this.graceSuccessor(winner) : null;
      if (replay) return replay;
      await this.handleReuse(current.userId, current.familyId, ip);
      throw invalidRefreshToken();
    }
    return {
      userId: current.userId,
      sessionId: current.familyId,
      refreshToken: rotated.refreshToken,
      expiresAt: rotated.expiresAt,
      mfa: rotated.mfa,
    };
  }

  private graceKey(tokenHash: Buffer): string {
    return `auth:refresh-grace:${tokenHash.toString('hex')}`;
  }

  /** Guarda el sucesor cifrado, con vida igual a la gracia (solo el hash vive en la base). */
  private async rememberSuccessor(
    tokenHash: Buffer,
    next: IssuedRefreshToken & { tokenId: string },
  ): Promise<void> {
    const grace = this.config.auth.refreshTokenGraceSeconds;
    if (grace <= 0) return;
    const sealed = this.encryption.encrypt(
      JSON.stringify({
        tokenId: next.tokenId,
        refreshToken: next.refreshToken,
        expiresAt: next.expiresAt.toISOString(),
      }),
      EncryptedField.REFRESH_GRACE_SUCCESSOR,
    );
    await this.redis.set(this.graceKey(tokenHash), sealed, 'EX', grace);
  }

  /**
   * El sucesor ya emitido, si el token se rotó hace menos de la gracia y ese sucesor sigue
   * vigente (no usado ni revocado). Si no, null: se trata como reutilización.
   */
  private async graceSuccessor(token: {
    tokenHash: Uint8Array;
    userId: string;
    familyId: string;
    revokedAt: Date | null;
    replacedBy: string | null;
  }): Promise<RotatedSession | null> {
    const grace = this.config.auth.refreshTokenGraceSeconds;
    if (grace <= 0 || !token.revokedAt || !token.replacedBy) return null;
    if (Date.now() - token.revokedAt.getTime() > grace * 1000) return null;
    const sealed = await this.redis.get(this.graceKey(Buffer.from(token.tokenHash)));
    if (!sealed) return null;
    let successor: { tokenId: string; refreshToken: string; expiresAt: string };
    try {
      successor = JSON.parse(
        this.encryption.decrypt(sealed, EncryptedField.REFRESH_GRACE_SUCCESSOR),
      ) as typeof successor;
    } catch {
      return null;
    }
    if (successor.tokenId !== token.replacedBy) return null;
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(successor.refreshToken) },
      select: { id: true, revokedAt: true, expiresAt: true, amr: true },
    });
    if (!row || row.id !== token.replacedBy || row.revokedAt || row.expiresAt <= new Date()) {
      return null;
    }
    this.logger.log({ sessionId: token.familyId }, 'Reintento de renovación dentro de la gracia');
    return {
      userId: token.userId,
      sessionId: token.familyId,
      refreshToken: successor.refreshToken,
      expiresAt: new Date(successor.expiresAt),
      mfa: row.amr === 'mfa',
    };
  }

  /** RF-AUT-003: cierra la sesión actual (su familia de tokens) de inmediato. */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, familyId: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Fase 10: el dispositivo de esa sesión deja de recibir push.
    await this.devices.removeForSessions(userId, [sessionId]);
    await this.revocations.revoke([sessionId]);
  }

  /**
   * Cierra todas las sesiones del usuario (cierre global o cambio de contraseña).
   * `tx` permite revocar los tokens dentro de la transacción que cambia la contraseña;
   * en ese caso hay que llamar después a `markRevoked` con las sesiones devueltas.
   */
  async revokeAllForUser(
    userId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<string[]> {
    const accessWindow = new Date(
      Date.now() - (this.config.auth.accessTokenTtlSeconds + 60) * 1000,
    );
    // Sesiones que aún pueden tener un token de acceso vigente.
    const families = await tx.refreshToken.findMany({
      where: { userId, OR: [{ revokedAt: null }, { createdAt: { gte: accessWindow } }] },
      select: { familyId: true },
      distinct: ['familyId'],
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Fase 10: sin sesiones, ningún dispositivo recibe push.
    await this.devices.removeAllForUser(userId, tx);
    return families.map((f) => f.familyId);
  }

  async markRevoked(sessionIds: string[]): Promise<void> {
    if (sessionIds.length > 0) await this.revocations.revoke(sessionIds);
  }

  private async handleReuse(userId: string, familyId: string, ip: string | null): Promise<void> {
    this.logger.warn({ userId, sessionId: familyId }, 'Reutilización de token de renovación');
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.devices.removeForSessions(userId, [familyId]);
    await this.revocations.revoke([familyId]);
    await this.audit.record({
      actorId: userId,
      action: 'auth.refresh_token_reused',
      entityType: 'session',
      entityId: familyId,
      ip,
    });
  }

  private async issue(
    tx: Prisma.TransactionClient,
    userId: string,
    sessionId: string,
    kind: SessionKind,
    deviceInfo?: Prisma.InputJsonValue,
  ): Promise<IssuedRefreshToken & { tokenId: string }> {
    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const now = Date.now();
    // Personal: 30 min sin renovar la cierran, y nunca pasa del tope de 12 h desde el inicio.
    const expiresAt =
      kind.mfa && kind.absoluteExpiresAt
        ? new Date(Math.min(now + STAFF_SESSION.idleMs, kind.absoluteExpiresAt.getTime()))
        : new Date(now + this.config.auth.refreshTokenTtlDays * DAY_MS);
    if (expiresAt.getTime() <= now) throw invalidRefreshToken();
    const row = await tx.refreshToken.create({
      data: {
        userId,
        familyId: sessionId,
        tokenHash: hashToken(refreshToken),
        expiresAt,
        deviceInfo,
        amr: kind.mfa ? 'mfa' : 'pwd',
        absoluteExpiresAt: kind.mfa ? kind.absoluteExpiresAt : null,
      },
      select: { id: true },
    });
    return { refreshToken, expiresAt, sessionId, tokenId: row.id, mfa: kind.mfa };
  }
}
