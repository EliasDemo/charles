import { Throttle } from '@nestjs/throttler';

const ONE_MINUTE_MS = 60_000;

/**
 * Límite que se puede cambiar en ejecución (por ejemplo, desde `app_settings`). El throttler lo
 * lee en cada petición, sin consultar la base: un proveedor lo refresca periódicamente.
 */
export class ConfigurableLimit {
  constructor(private current: number) {}

  get value(): number {
    return this.current;
  }

  /** Ignora valores no válidos (se mantiene el anterior). */
  set(value: number): void {
    if (Number.isInteger(value) && value > 0) this.current = value;
  }
}

/** Búsqueda (Fase 6): 60/min por IP por defecto; `search.rate_limit_per_minute`. */
export const SEARCH_RATE_LIMIT_DEFAULT = 60;
export const SEARCH_RATE_LIMIT = new ConfigurableLimit(SEARCH_RATE_LIMIT_DEFAULT);

/**
 * Perfiles de límite más estrictos que el global (CLAUDE.md §6.5).
 * Se aplican en las fases de auth, pagos y búsqueda con `@RateLimit('auth')`.
 */
export const RATE_LIMIT_PROFILES = {
  auth: { limit: 10, ttl: ONE_MINUTE_MS },
  payments: { limit: 20, ttl: ONE_MINUTE_MS },
  search: { limit: (): number => SEARCH_RATE_LIMIT.value, ttl: ONE_MINUTE_MS },
  /** Consultas públicas sin sesión (barberías, servicios, barberos). */
  public: { limit: 60, ttl: ONE_MINUTE_MS },
} as const;

export type RateLimitProfile = keyof typeof RATE_LIMIT_PROFILES;

export const RateLimit = (profile: RateLimitProfile): MethodDecorator & ClassDecorator =>
  Throttle({ default: { ...RATE_LIMIT_PROFILES[profile] } });
