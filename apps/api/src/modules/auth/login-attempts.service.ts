import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

/** CLAUDE.md §4.1: tras 5 fallos, bloqueo progresivo de 1, 5 y 15 minutos, por cuenta y por IP. */
export const LOCKOUT_POLICY = {
  maxFailures: 5,
  lockSeconds: [60, 5 * 60, 15 * 60] as const,
  /** Los fallos se olvidan si no se repiten en esta ventana. */
  failureWindowSeconds: 15 * 60,
  /** El nivel de bloqueo (1, 5 o 15 min) se reinicia tras un día sin bloqueos. */
  levelTtlSeconds: 24 * 60 * 60,
} as const;

/**
 * Registra un fallo de forma atómica. Devuelve los segundos de bloqueo impuestos (0 si ninguno).
 * KEYS: fallos, nivel, bloqueo. ARGV: ventana, máximo, ttl del nivel, duraciones...
 */
const RECORD_FAILURE_SCRIPT = `
local fails = redis.call('INCR', KEYS[1])
if fails == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if fails < tonumber(ARGV[2]) then return 0 end
redis.call('DEL', KEYS[1])
local level = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local durations = { tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6]) }
local seconds = durations[math.min(level, 3)]
redis.call('SET', KEYS[3], '1', 'EX', seconds)
return seconds
`;

/** Clave de cuenta: índice ciego del correo (existe o no la cuenta, se trata igual). */
export interface AttemptSubject {
  accountKey: string;
  ip: string;
}

export interface FailureResult {
  /** Segundos de bloqueo impuestos a la cuenta en este fallo (0 si ninguno). */
  accountLockSeconds: number;
}

/** Bloqueo progresivo por intentos fallidos (inicio de sesión y códigos de un solo uso). */
@Injectable()
export class LoginAttemptsService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Lanza 429 ACCOUNT_LOCKED si la cuenta o la IP están bloqueadas. */
  async assertNotLocked(subject: AttemptSubject): Promise<void> {
    const [accountTtl, ipTtl] = await Promise.all([
      this.redis.ttl(this.keys('account', subject.accountKey).lock),
      this.redis.ttl(this.keys('ip', subject.ip).lock),
    ]);
    const retryAfterSeconds = Math.max(accountTtl, ipTtl);
    if (retryAfterSeconds > 0) {
      const minutes = Math.ceil(retryAfterSeconds / 60);
      throw new AppException(
        ErrorCode.ACCOUNT_LOCKED,
        `Demasiados intentos fallidos. Intenta nuevamente en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`,
        HttpStatus.TOO_MANY_REQUESTS,
        [{ retryAfterSeconds }],
      );
    }
  }

  async recordFailure(subject: AttemptSubject): Promise<FailureResult> {
    const [accountLockSeconds] = await Promise.all([
      this.record('account', subject.accountKey),
      this.record('ip', subject.ip),
    ]);
    return { accountLockSeconds };
  }

  /** Un acceso correcto reinicia los fallos y el nivel de la cuenta (no los de la IP). */
  async recordSuccess(accountKey: string): Promise<void> {
    const keys = this.keys('account', accountKey);
    await this.redis.del(keys.failures, keys.level);
  }

  private async record(scope: 'account' | 'ip', id: string): Promise<number> {
    const keys = this.keys(scope, id);
    const result = await this.redis.eval(
      RECORD_FAILURE_SCRIPT,
      3,
      keys.failures,
      keys.level,
      keys.lock,
      LOCKOUT_POLICY.failureWindowSeconds,
      LOCKOUT_POLICY.maxFailures,
      LOCKOUT_POLICY.levelTtlSeconds,
      ...LOCKOUT_POLICY.lockSeconds,
    );
    return Number(result);
  }

  private keys(scope: 'account' | 'ip', id: string) {
    const base = `auth:attempts:${scope}:${id}`;
    return { failures: `${base}:failures`, level: `${base}:level`, lock: `${base}:lock` };
  }
}
