import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import { randomJwtPrivateKey } from '../../../test/support/random-keys';
import type { AppConfig } from '../config/env.validation';
import { parseJwtPrivateKey } from './jwt-keys';
import { TokenService } from './token.service';

function configWith(privateKeyB64 = randomJwtPrivateKey(), ttl = 900): AppConfig {
  const jwtKeys = parseJwtPrivateKey(privateKeyB64).value!;
  return {
    auth: {
      jwtKeys,
      issuer: 'charles-api',
      audience: 'charles-clients',
      accessTokenTtlSeconds: ttl,
      refreshTokenTtlDays: 30,
    },
  } as AppConfig;
}

describe('TokenService (JWT ES256)', () => {
  const config = configWith();
  const service = new TokenService(config);
  const user = { id: randomUUID(), roles: ['CLIENT' as const, 'OWNER' as const] };
  const sessionId = randomUUID();

  it('firma con ES256 y verifica: devuelve usuario, roles y sesión', () => {
    const { token, expiresAt } = service.signAccessToken(user, sessionId);
    const [header] = token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toMatchObject({
      alg: 'ES256',
    });
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(899_000);
    expect(service.verifyAccessToken(token)).toEqual({ id: user.id, roles: user.roles, sessionId });
  });

  it('el token no contiene datos personales', () => {
    const { token } = service.signAccessToken(user, sessionId);
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as object;
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'roles', 'sid', 'sub']);
  });

  it('rechaza un token firmado con otra clave', () => {
    const other = new TokenService(configWith());
    expect(service.verifyAccessToken(other.signAccessToken(user, sessionId).token)).toBeUndefined();
  });

  it('rechaza HS256 firmado con la clave pública (confusión de algoritmo) y alg none', () => {
    const publicPem = config.auth.jwtKeys.publicKey.export({ type: 'spki', format: 'pem' });
    const claims = { sid: sessionId, roles: ['SUPPORT'] };
    const options = { subject: user.id, issuer: 'charles-api', audience: 'charles-clients' };
    const hs = sign(claims, publicPem, { ...options, algorithm: 'HS256' });
    const none = sign(claims, '', { ...options, algorithm: 'none' });
    expect(service.verifyAccessToken(hs)).toBeUndefined();
    expect(service.verifyAccessToken(none)).toBeUndefined();
  });

  it('rechaza emisor o audiencia distintos', () => {
    const { privateKey } = config.auth.jwtKeys;
    const claims = { sid: sessionId, roles: ['CLIENT'] };
    const base = { algorithm: 'ES256' as const, subject: user.id, expiresIn: 60 };
    expect(
      service.verifyAccessToken(
        sign(claims, privateKey, { ...base, issuer: 'otro', audience: 'charles-clients' }),
      ),
    ).toBeUndefined();
    expect(
      service.verifyAccessToken(
        sign(claims, privateKey, { ...base, issuer: 'charles-api', audience: 'otra' }),
      ),
    ).toBeUndefined();
  });

  it('rechaza un token vencido', () => {
    const { privateKey } = config.auth.jwtKeys;
    const expired = sign({ sid: sessionId, roles: ['CLIENT'] }, privateKey, {
      algorithm: 'ES256',
      subject: user.id,
      issuer: 'charles-api',
      audience: 'charles-clients',
      expiresIn: -60,
    });
    expect(service.verifyAccessToken(expired)).toBeUndefined();
  });

  it.each([
    ['rol desconocido', { sid: randomUUID(), roles: ['ADMIN'] }],
    ['sin sesión', { roles: ['CLIENT'] }],
    ['roles no es lista', { sid: randomUUID(), roles: 'CLIENT' }],
  ])('rechaza claims inválidos: %s', (_case, claims) => {
    const token = sign(claims, config.auth.jwtKeys.privateKey, {
      algorithm: 'ES256',
      subject: user.id,
      issuer: 'charles-api',
      audience: 'charles-clients',
      expiresIn: 60,
    });
    expect(service.verifyAccessToken(token)).toBeUndefined();
  });

  it.each(['', 'abc', 'a.b.c'])('rechaza texto que no es un JWT: %p', (token) => {
    expect(service.verifyAccessToken(token)).toBeUndefined();
  });
});

describe('parseJwtPrivateKey', () => {
  it('acepta una clave EC P-256 en PEM PKCS#8 codificada en base64', () => {
    const result = parseJwtPrivateKey(randomJwtPrivateKey());
    expect(result.errors).toEqual([]);
    expect(result.value?.publicKey.asymmetricKeyType).toBe('ec');
  });

  it.each([
    ['vacía', ''],
    ['no base64 de PEM', 'no-es-una-clave'],
    ['PEM sin codificar en base64', '-----BEGIN PRIVATE KEY-----'],
  ])('rechaza una clave %s sin revelar su valor', (_case, raw) => {
    const result = parseJwtPrivateKey(raw);
    expect(result.value).toBeUndefined();
    expect(result.errors.join(' ')).not.toContain(raw || '\u0001');
  });

  it('rechaza una clave RSA (solo ES256)', () => {
    const { generateKeyPairSync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const raw = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    expect(parseJwtPrivateKey(raw).value).toBeUndefined();
  });
});
