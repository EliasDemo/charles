import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { SessionRevocationStore } from '../../common/auth/session-revocation.store';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

const REFRESH_TOKEN_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IssuedRefreshToken {
  refreshToken: string;
  expiresAt: Date;
  sessionId: string;
}

export interface RotatedSession extends IssuedRefreshToken {
  userId: string;
}

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
  ) {}

  async create(userId: string, deviceInfo?: Prisma.InputJsonValue): Promise<IssuedRefreshToken> {
    const sessionId = randomUUID();
    return this.issue(this.prisma, userId, sessionId, deviceInfo);
  }

  /**
   * Rota el token: el usado queda revocado y apunta a su reemplazo. Si llega un token ya rotado
   * o revocado, se asume robo y se revoca toda la familia.
   */
  async rotate(refreshToken: string, ip: string | null): Promise<RotatedSession> {
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!current) throw invalidRefreshToken();

    if (current.revokedAt) {
      if (current.replacedBy) await this.handleReuse(current.userId, current.familyId, ip);
      throw invalidRefreshToken();
    }
    if (current.expiresAt <= new Date()) throw invalidRefreshToken();

    const rotated = await this.prisma.$transaction(async (tx) => {
      const next = await this.issue(
        tx,
        current.userId,
        current.familyId,
        current.deviceInfo ?? undefined,
      );
      // Condicional: si otra petición rotó el mismo token a la vez, solo una gana.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedBy: next.tokenId },
      });
      if (count === 0) return null;
      return next;
    });

    if (!rotated) {
      await this.handleReuse(current.userId, current.familyId, ip);
      throw invalidRefreshToken();
    }
    return {
      userId: current.userId,
      sessionId: current.familyId,
      refreshToken: rotated.refreshToken,
      expiresAt: rotated.expiresAt,
    };
  }

  /** RF-AUT-003: cierra la sesión actual (su familia de tokens) de inmediato. */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, familyId: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
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
    deviceInfo?: Prisma.InputJsonValue,
  ): Promise<IssuedRefreshToken & { tokenId: string }> {
    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.auth.refreshTokenTtlDays * DAY_MS);
    const row = await tx.refreshToken.create({
      data: {
        userId,
        familyId: sessionId,
        tokenHash: hashToken(refreshToken),
        expiresAt,
        deviceInfo,
      },
      select: { id: true },
    });
    return { refreshToken, expiresAt, sessionId, tokenId: row.id };
  }
}
