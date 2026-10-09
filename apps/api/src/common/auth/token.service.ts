import { Inject, Injectable } from '@nestjs/common';
import { sign, verify } from 'jsonwebtoken';
import { Role } from '../../generated/prisma/enums';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/env.validation';
import type { AuthUser, RestrictedScope } from './auth-user';

const ALGORITHM = 'ES256';
const CLOCK_TOLERANCE_SECONDS = 5;
const VALID_ROLES = new Set<string>(Object.values(Role));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AccessTokenClaims {
  sub: string;
  sid: string;
  roles: Role[];
  /** Fase 12: `support` = sesión restringida de una cuenta deshabilitada (solo tickets). */
  scp?: RestrictedScope;
}

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

/** Token de acceso JWT ES256 de vida corta (CLAUDE.md §6.3). */
@Injectable()
export class TokenService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  signAccessToken(
    user: { id: string; roles: Role[] },
    sessionId: string,
    options: { restricted?: RestrictedScope } = {},
  ): SignedAccessToken {
    const { jwtKeys, issuer, audience, accessTokenTtlSeconds } = this.config.auth;
    const claims: Omit<AccessTokenClaims, 'sub'> = options.restricted
      ? { sid: sessionId, roles: [], scp: options.restricted }
      : { sid: sessionId, roles: user.roles };
    const token = sign(claims, jwtKeys.privateKey, {
      algorithm: ALGORITHM,
      subject: user.id,
      issuer,
      audience,
      expiresIn: accessTokenTtlSeconds,
    });
    return { token, expiresAt: new Date(Date.now() + accessTokenTtlSeconds * 1000) };
  }

  /** Devuelve el usuario si el token es válido; `undefined` en cualquier otro caso. */
  verifyAccessToken(token: string): AuthUser | undefined {
    const { jwtKeys, issuer, audience } = this.config.auth;
    try {
      const payload = verify(token, jwtKeys.publicKey, {
        algorithms: [ALGORITHM],
        issuer,
        audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      if (typeof payload === 'string') return undefined;
      const { sub, sid, roles, scp } = payload as Partial<AccessTokenClaims>;
      if (
        typeof sub !== 'string' ||
        !UUID.test(sub) ||
        typeof sid !== 'string' ||
        !UUID.test(sid) ||
        !Array.isArray(roles) ||
        !roles.every((r) => VALID_ROLES.has(r)) ||
        (scp !== undefined && scp !== 'support' && scp !== 'deletion')
      ) {
        return undefined;
      }
      return scp
        ? { id: sub, sessionId: sid, roles: [], restricted: scp }
        : { id: sub, sessionId: sid, roles };
    } catch {
      return undefined;
    }
  }
}
