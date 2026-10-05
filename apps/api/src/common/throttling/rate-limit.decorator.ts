import { Throttle } from '@nestjs/throttler';

const ONE_MINUTE_MS = 60_000;

/**
 * Perfiles de límite más estrictos que el global (CLAUDE.md §6.5).
 * Se aplican en las fases de auth, pagos y búsqueda con `@RateLimit('auth')`.
 */
export const RATE_LIMIT_PROFILES = {
  auth: { limit: 10, ttl: ONE_MINUTE_MS },
  payments: { limit: 20, ttl: ONE_MINUTE_MS },
  search: { limit: 60, ttl: ONE_MINUTE_MS },
  /** Consultas públicas sin sesión (barberías, servicios, barberos). */
  public: { limit: 60, ttl: ONE_MINUTE_MS },
} as const;

export type RateLimitProfile = keyof typeof RATE_LIMIT_PROFILES;

export const RateLimit = (profile: RateLimitProfile): MethodDecorator & ClassDecorator =>
  Throttle({ default: { ...RATE_LIMIT_PROFILES[profile] } });
