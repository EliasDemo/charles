import { AppException } from '../../../common/errors/app.exception';
import { MercadoPagoGateway } from '../mercadopago/mercadopago-gateway';
import {
  FakeSellerOAuthClient,
  SellerAccountsService,
  SellerOAuthCallbackController,
  sellerOAuthClientFactory,
  type SellerOAuthClient,
} from './seller-accounts';

const NOW = Date.parse('2030-01-07T15:00:00Z');
const DAY = 86_400_000;

const config = (clientId: string | null = 'cid', clientSecret: string | null = 'secret') =>
  ({
    payments: {
      publicApiUrl: 'https://api.charles.test',
      mercadoPago: {
        apiUrl: 'https://mp.test',
        clientId,
        clientSecret,
        accessToken: 'APP',
        webhookSecret: 's',
      },
    },
  }) as never;

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

describe('OAuth de Mercado Pago (Marketplace)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('elige el cliente real con Mercado Pago y el simulado con la pasarela FAKE', () => {
    expect(sellerOAuthClientFactory(config(), { provider: 'FAKE' } as never)).toBeInstanceOf(
      FakeSellerOAuthClient,
    );
    const mp = sellerOAuthClientFactory(config(), { provider: 'MERCADOPAGO' } as never);
    const url = new URL(mp.authorizationUrl('st', 'https://api.charles.test/cb'));
    expect(url.origin).toBe('https://auth.mercadopago.com');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('sin Client ID o secreto: error claro (503)', () => {
    const mp = sellerOAuthClientFactory(config(null, null), { provider: 'MERCADOPAGO' } as never);
    expect(() => mp.authorizationUrl('st', 'x')).toThrow(AppException);
  });

  it('canjea el código y renueva el token; errores del proveedor → 502', async () => {
    const mp = sellerOAuthClientFactory(config(), { provider: 'MERCADOPAGO' } as never);
    const fetchMock = jest.fn(() =>
      json(200, {
        access_token: 'AT',
        refresh_token: 'RT',
        user_id: 123,
        public_key: 'PK',
        expires_in: 100,
      }),
    );
    global.fetch = fetchMock as never;
    await expect(mp.exchangeCode('code', 'https://cb')).resolves.toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      providerUserId: '123',
      publicKey: 'PK',
      expiresInSeconds: 100,
    });
    global.fetch = jest.fn(() => json(200, { access_token: 'AT2', user_id: '9' })) as never;
    await expect(mp.refresh('RT')).resolves.toMatchObject({
      accessToken: 'AT2',
      refreshToken: null,
      publicKey: null,
      expiresInSeconds: null,
    });
    global.fetch = jest.fn(() => json(400, { error: 'invalid_grant' })) as never;
    await expect(mp.exchangeCode('bad', 'x')).rejects.toBeInstanceOf(AppException);
    global.fetch = jest.fn(() => Promise.reject(new Error('timeout'))) as never;
    await expect(mp.refresh('RT')).rejects.toBeInstanceOf(AppException);
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('no json')),
      } as unknown as Response),
    ) as never;
    await expect(mp.refresh('RT')).rejects.toBeInstanceOf(AppException);
  });

  it('el simulado solo acepta sus propios códigos', async () => {
    const fake = new FakeSellerOAuthClient();
    expect(fake.authorizationUrl('abc', 'https://cb')).toBe('https://cb?code=fake-abc&state=abc');
    await expect(fake.exchangeCode('fake-abc')).resolves.toMatchObject({
      refreshToken: expect.any(String),
    });
    await expect(fake.exchangeCode('otro')).rejects.toBeInstanceOf(AppException);
    await expect(fake.refresh()).resolves.toMatchObject({
      accessToken: expect.stringContaining('FAKE'),
    });
  });
});

describe('SellerAccountsService', () => {
  function build(
    account: Record<string, unknown> | null,
    options: {
      oauth?: Partial<SellerOAuthClient>;
      gateway?: unknown;
      publicApiUrl?: string | null;
    } = {},
  ) {
    const prisma: Record<string, unknown> = {
      sellerAccount: {
        findUnique: jest.fn().mockResolvedValue(account),
        findFirst: jest.fn().mockResolvedValue(account ? { barbershopId: 'shop' } : null),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: account ? 1 : 0 }),
      },
    };
    prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma));
    const oauth = {
      authorizationUrl: jest.fn(() => 'https://auth/x'),
      exchangeCode: jest.fn().mockResolvedValue({
        accessToken: 'AT',
        refreshToken: null,
        providerUserId: '77',
        publicKey: null,
        expiresInSeconds: null,
      }),
      refresh: jest.fn().mockResolvedValue({
        accessToken: 'NEW',
        refreshToken: 'RT2',
        providerUserId: '77',
        publicKey: null,
        expiresInSeconds: 3600,
      }),
      ...options.oauth,
    };
    const crypto = {
      encrypt: jest.fn((v: string) => `enc:${v}`),
      decrypt: jest.fn((v: string) => v.replace('enc:', '')),
    };
    const audit = { record: jest.fn() };
    const access = { requireMember: jest.fn() };
    const cfg = {
      payments: {
        publicApiUrl: options.publicApiUrl === undefined ? 'https://api.x' : options.publicApiUrl,
      },
    };
    const service = new SellerAccountsService(
      prisma as never,
      access as never,
      crypto as never,
      audit as never,
      cfg as never,
      (options.gateway ?? { provider: 'FAKE' }) as never,
      oauth,
      { now: () => NOW },
    );
    return { service, prisma, oauth, audit };
  }

  const connected = (extra: Record<string, unknown> = {}) => ({
    id: 'acc',
    barbershopId: 'shop',
    provider: 'FAKE',
    status: 'CONNECTED',
    providerUserId: '77',
    accessTokenEnc: 'enc:AT',
    refreshTokenEnc: 'enc:RT',
    tokenExpiresAt: new Date(NOW + 100 * DAY),
    connectedAt: new Date(NOW - DAY),
    ...extra,
  });

  it('estado: sin cuenta y vinculada', async () => {
    expect((await build(null).service.status('u', 'shop')).status).toBe('NOT_CONNECTED');
    expect((await build(connected()).service.status('u', 'shop')).status).toBe('CONNECTED');
  });

  it('vincular: genera estado y enlace (con o sin URL pública)', async () => {
    const { service, prisma } = build(null, { publicApiUrl: null });
    const res = await service.connect('u', 'shop');
    expect(res.authorizationUrl).toBe('https://auth/x');
    expect((prisma.sellerAccount as { upsert: jest.Mock }).upsert).toHaveBeenCalled();
  });

  it('regreso: rechaza un estado vencido o desconocido y guarda los tokens cifrados', async () => {
    await expect(build(null).service.completeAuthorization('c', 's')).rejects.toBeInstanceOf(
      AppException,
    );
    await expect(
      build({
        ...connected(),
        oauthStateExpiresAt: new Date(NOW - 1),
      }).service.completeAuthorization('c', 's'),
    ).rejects.toBeInstanceOf(AppException);
    const { service, prisma, audit } = build({
      ...connected(),
      oauthStateExpiresAt: new Date(NOW + 60_000),
    });
    await expect(service.completeAuthorization('c', 's')).resolves.toEqual({
      barbershopId: 'shop',
    });
    expect((prisma.sellerAccount as { update: jest.Mock }).update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accessTokenEnc: 'enc:AT', refreshTokenEnc: null }),
      }),
    );
    expect(audit.record).toHaveBeenCalled();
  });

  it('desvincular audita solo si había algo que revocar', async () => {
    const none = build(null);
    await none.service.disconnect('u', 'shop');
    expect(none.audit.record).not.toHaveBeenCalled();
    const some = build(connected());
    await some.service.disconnect('u', 'shop');
    expect(some.audit.record).toHaveBeenCalled();
  });

  it('isConnectedInTx: solo CONNECTED y con la misma pasarela', async () => {
    const tx = (a: unknown) => ({ sellerAccount: { findUnique: jest.fn().mockResolvedValue(a) } });
    const { service } = build(null);
    await expect(service.isConnectedInTx(tx(null) as never, 'shop')).resolves.toBe(false);
    await expect(
      service.isConnectedInTx(tx({ status: 'CONNECTED', provider: 'FAKE' }) as never, 'shop'),
    ).resolves.toBe(true);
    await expect(
      service.isConnectedInTx(
        tx({ status: 'CONNECTED', provider: 'MERCADOPAGO' }) as never,
        'shop',
      ),
    ).resolves.toBe(false);
  });

  it('credenciales: vigentes, renovadas, renovación fallida y no vinculada', async () => {
    await expect(build(null).service.credentialsFor('shop')).resolves.toBeNull();
    await expect(
      build(connected({ status: 'REVOKED' })).service.credentialsFor('shop'),
    ).resolves.toBeNull();
    await expect(build(connected()).service.credentialsFor('shop')).resolves.toEqual({
      accessToken: 'AT',
      providerUserId: '77',
    });
    const expiring = build(connected({ tokenExpiresAt: new Date(NOW + DAY) }));
    await expect(expiring.service.credentialsFor('shop')).resolves.toEqual({
      accessToken: 'NEW',
      providerUserId: '77',
    });
    const failSoon = build(connected({ tokenExpiresAt: new Date(NOW + DAY) }), {
      oauth: { refresh: jest.fn().mockRejectedValue(new Error('x')) },
    });
    await expect(failSoon.service.credentialsFor('shop')).resolves.toEqual({
      accessToken: 'AT',
      providerUserId: '77',
    });
    const failExpired = build(connected({ tokenExpiresAt: new Date(NOW - 1) }), {
      oauth: { refresh: jest.fn().mockRejectedValue(new Error('x')) },
    });
    await expect(failExpired.service.credentialsFor('shop')).resolves.toBeNull();
  });

  it('token por cuenta de Mercado Pago (webhooks) y registro en la pasarela real', async () => {
    await expect(build(connected()).service.tokenForProviderUser('77')).resolves.toBe('AT');
    await expect(build(null).service.tokenForProviderUser('77')).resolves.toBeNull();
    const gateway = Object.create(MercadoPagoGateway.prototype) as MercadoPagoGateway;
    const spy = jest.spyOn(gateway, 'setSellerTokenResolver').mockImplementation(() => undefined);
    build(null, { gateway }).service.onModuleInit();
    expect(spy).toHaveBeenCalled();
    build(null).service.onModuleInit();
  });
});

describe('Página de regreso del OAuth', () => {
  const res = () => {
    const r = { status: jest.fn(), setHeader: jest.fn(), send: jest.fn() };
    r.status.mockReturnValue(r);
    r.setHeader.mockReturnValue(r);
    return r;
  };

  it('sin código, éxito, error conocido y error inesperado', async () => {
    const ok = { completeAuthorization: jest.fn().mockResolvedValue({}) };
    let r = res();
    await new SellerOAuthCallbackController(ok as never).callback(undefined, 's', r as never);
    expect(r.status).toHaveBeenCalledWith(400);
    r = res();
    await new SellerOAuthCallbackController(ok as never).callback('c', 's', r as never);
    expect(r.status).toHaveBeenCalledWith(200);
    const known = {
      completeAuthorization: jest
        .fn()
        .mockRejectedValue(new AppException('VALIDATION_ERROR', 'Venció', 400)),
    };
    r = res();
    await new SellerOAuthCallbackController(known as never).callback('c', 's', r as never);
    expect(String(r.send.mock.calls[0]?.[0])).toContain('Venció');
    const unknown = { completeAuthorization: jest.fn().mockRejectedValue(new Error('x')) };
    r = res();
    await new SellerOAuthCallbackController(unknown as never).callback('c', 's', r as never);
    expect(r.status).toHaveBeenCalledWith(400);
  });
});
