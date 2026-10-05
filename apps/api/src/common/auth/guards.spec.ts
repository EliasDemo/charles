import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import type { AuthenticatedRequest, AuthUser } from './auth-user';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';
import { RolesGuard } from './roles.guard';
import type { SessionRevocationStore } from './session-revocation.store';
import type { TokenService } from './token.service';

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function reflectorWith(metadata: Record<string, unknown>): Reflector {
  return { getAllAndOverride: (key: string) => metadata[key] } as unknown as Reflector;
}

const user: AuthUser = { id: randomUUID(), roles: ['CLIENT'], sessionId: randomUUID() };

describe('JwtAuthGuard (deniega por defecto)', () => {
  const tokens = { verifyAccessToken: jest.fn() } as unknown as jest.Mocked<TokenService>;
  const revocations = { isRevoked: jest.fn() } as unknown as jest.Mocked<SessionRevocationStore>;
  const guard = (metadata: Record<string, unknown> = {}) =>
    new JwtAuthGuard(reflectorWith(metadata), tokens, revocations);

  beforeEach(() => {
    jest.resetAllMocks();
    tokens.verifyAccessToken.mockReturnValue(user);
    revocations.isRevoked.mockResolvedValue(false);
  });

  it('deja pasar endpoints @Public sin token', async () => {
    await expect(
      guard({ [IS_PUBLIC_KEY]: true }).canActivate(contextFor({ headers: {} })),
    ).resolves.toBe(true);
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'token-sin-esquema'])(
    'rechaza la cabecera Authorization %p',
    async (authorization) => {
      const request = { headers: authorization === undefined ? {} : { authorization } };
      await expect(guard().canActivate(contextFor(request))).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    },
  );

  it('rechaza un token inválido', async () => {
    tokens.verifyAccessToken.mockReturnValue(undefined);
    await expect(
      guard().canActivate(contextFor({ headers: { authorization: 'Bearer x' } })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rechaza una sesión revocada (RF-AUT-003)', async () => {
    revocations.isRevoked.mockResolvedValue(true);
    await expect(
      guard().canActivate(contextFor({ headers: { authorization: 'Bearer x' } })),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('falla de forma cerrada si no puede consultar Redis', async () => {
    revocations.isRevoked.mockRejectedValue(new Error('redis caído'));
    await expect(
      guard().canActivate(contextFor({ headers: { authorization: 'Bearer x' } })),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('adjunta el usuario del token a la petición', async () => {
    const request: Partial<AuthenticatedRequest> = { headers: { authorization: 'bearer x' } };
    await expect(guard().canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toEqual(user);
  });
});

describe('RolesGuard', () => {
  it('sin @Roles no exige rol', () => {
    expect(new RolesGuard(reflectorWith({})).canActivate(contextFor({ user }))).toBe(true);
  });

  it('permite si el usuario tiene alguno de los roles', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: ['OWNER', 'CLIENT'] }));
    expect(guard.canActivate(contextFor({ user }))).toBe(true);
  });

  it('responde 403 FORBIDDEN si no tiene el rol', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: ['SUPPORT'] }));
    expect(() => guard.canActivate(contextFor({ user }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('responde 403 si no hay usuario autenticado', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: ['CLIENT'] }));
    expect(() => guard.canActivate(contextFor({}))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});
