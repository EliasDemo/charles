import type { Request } from 'express';
import { clientIpOf } from './client-ip-throttler.guard';
import {
  ConfigurableLimit,
  RATE_LIMIT_PROFILES,
  RateLimit,
  SEARCH_RATE_LIMIT,
} from './rate-limit.decorator';

describe('clientIpOf', () => {
  it('usa req.ip (resuelta por Express según TRUST_PROXY)', () => {
    expect(
      clientIpOf({ ip: '203.0.113.5', socket: { remoteAddress: '127.0.0.1' } } as Request),
    ).toBe('203.0.113.5');
  });

  it('recurre a la dirección del socket si no hay req.ip', () => {
    expect(clientIpOf({ socket: { remoteAddress: '10.0.0.1' } } as Request)).toBe('10.0.0.1');
  });
});

describe('RateLimit', () => {
  it('los perfiles estrictos son menores que el límite global por defecto', () => {
    for (const profile of Object.values(RATE_LIMIT_PROFILES)) {
      const limit = typeof profile.limit === 'function' ? profile.limit() : profile.limit;
      expect(limit).toBeLessThan(100);
    }
  });

  it('búsqueda: 60/min por defecto, configurable en ejecución; ignora valores inválidos', () => {
    expect(SEARCH_RATE_LIMIT.value).toBe(60);
    const limit = new ConfigurableLimit(60);
    limit.set(30);
    expect(limit.value).toBe(30);
    for (const bad of [0, -5, 2.5, Number.NaN]) limit.set(bad);
    expect(limit.value).toBe(30);
    const resolve = RATE_LIMIT_PROFILES.search.limit;
    expect(resolve()).toBe(SEARCH_RATE_LIMIT.value);
  });

  it('aplica la metadata del throttler al método', () => {
    class Target {
      @RateLimit('auth')
      login(): void {}
    }
    const keys = Reflect.getMetadataKeys(Target.prototype.login) as string[];
    expect(keys.some((k) => k.includes('THROTTLER:LIMIT'))).toBe(true);
    const limitKey = keys.find((k) => k.includes('THROTTLER:LIMIT'))!;
    expect(Reflect.getMetadata(limitKey, Target.prototype.login)).toBe(
      RATE_LIMIT_PROFILES.auth.limit,
    );
  });
});
