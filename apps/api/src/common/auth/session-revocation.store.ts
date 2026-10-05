import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/env.validation';
import { REDIS_CLIENT } from '../redis/redis.module';

const KEY_PREFIX = 'auth:revoked-session:';

/**
 * Lista de sesiones revocadas. Al cerrar sesión, el token de acceso (que vive hasta 15 min)
 * deja de ser válido al instante: el guard consulta esta lista en cada petición (RF-AUT-003).
 * Basta con conservar la marca durante la vida máxima del token de acceso.
 */
@Injectable()
export class SessionRevocationStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async revoke(sessionIds: Iterable<string>): Promise<void> {
    const ttl = this.config.auth.accessTokenTtlSeconds + 60;
    const pipeline = this.redis.pipeline();
    for (const id of new Set(sessionIds)) pipeline.set(`${KEY_PREFIX}${id}`, '1', 'EX', ttl);
    await pipeline.exec();
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(`${KEY_PREFIX}${sessionId}`)) === 1;
  }
}
