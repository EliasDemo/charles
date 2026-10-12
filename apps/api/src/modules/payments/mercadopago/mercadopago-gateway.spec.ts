import { createHmac } from 'node:crypto';
import { type AppConfig, PaymentsGateway } from '../../../common/config/env.validation';
import { InvalidSignatureError, PaymentGatewayError } from '../payment-gateway';
import {
  fromMercadoPagoAmount,
  isValidMercadoPagoSignature,
  MercadoPagoGateway,
  mercadoPagoManifest,
  toMercadoPagoAmount,
} from './mercadopago-gateway';

const SECRET = 'secreto-webhook';

function gateway(
  publicApiUrl: string | null = 'https://api.charles.test',
  accessToken: string | null = 'APP_USR-x',
) {
  const config = {
    payments: {
      gateway: PaymentsGateway.MercadoPago,
      publicApiUrl,
      mercadoPago: { accessToken, webhookSecret: SECRET, apiUrl: 'https://mp.test' },
    },
  } as unknown as AppConfig;
  return new MercadoPagoGateway(config, { now: () => 1_900_000_000_000 });
}

function mockFetch(...responses: (object | Error | { status: number; text: string })[]) {
  const spy = jest.spyOn(globalThis, 'fetch');
  for (const r of responses) {
    if (r instanceof Error) spy.mockRejectedValueOnce(r);
    else if ('text' in r && 'status' in r) {
      spy.mockResolvedValueOnce(new Response(r.text, { status: r.status }));
    } else spy.mockResolvedValueOnce(Response.json(r));
  }
  return spy;
}

const signed = (dataId: string, body: object, secret = SECRET) => {
  const ts = '1704908010';
  const requestId = 'req-1';
  const v1 = createHmac('sha256', secret)
    .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
    .digest('hex');
  return {
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
  };
};

describe('Mercado Pago', () => {
  afterEach(() => jest.restoreAllMocks());

  it('manifiesto y firma como el SDK oficial (se omite lo que falta)', () => {
    expect(mercadoPagoManifest('123', 'req', '1')).toBe('id:123;request-id:req;ts:1;');
    expect(mercadoPagoManifest(undefined, undefined, '1')).toBe('ts:1;');
    const v1 = createHmac('sha256', SECRET).update('id:9;request-id:r;ts:5;').digest('hex');
    const ok = { signature: `ts=5,v1=${v1}`, requestId: 'r', dataId: '9', secret: SECRET };
    expect(isValidMercadoPagoSignature(ok)).toBe(true);
    expect(isValidMercadoPagoSignature({ ...ok, signature: ` TS=5 , V1=${v1} ` })).toBe(true);
    expect(isValidMercadoPagoSignature({ ...ok, dataId: '8' })).toBe(false);
    expect(isValidMercadoPagoSignature({ ...ok, secret: 'otro' })).toBe(false);
    expect(isValidMercadoPagoSignature({ ...ok, signature: `v1=${v1}` })).toBe(false);
    expect(isValidMercadoPagoSignature({ ...ok, signature: 'ts=x,v1=abc' })).toBe(false);
    expect(isValidMercadoPagoSignature({ ...ok, signature: 'basura' })).toBe(false);
    expect(isValidMercadoPagoSignature({ ...ok, signature: undefined })).toBe(false);
  });

  it('montos: céntimos ↔ soles', () => {
    expect(toMercadoPagoAmount(2550)).toBe(25.5);
    expect(fromMercadoPagoAmount(25.5)).toBe(2550);
    expect(fromMercadoPagoAmount(0.1 + 0.2)).toBe(30);
    expect(fromMercadoPagoAmount(-1)).toBeNull();
    expect(fromMercadoPagoAmount('25')).toBeNull();
  });

  it('sin PUBLIC_API_URL o sin access token no llama a Mercado Pago', async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    const input = {
      paymentId: 'p',
      amount: 1,
      currency: 'PEN',
      idempotencyKey: 'k',
      description: '',
    };
    await expect(gateway(null).createPayment(input)).rejects.toBeInstanceOf(PaymentGatewayError);
    await expect(gateway(undefined, null).createPayment(input)).rejects.toThrow(/ACCESS_TOKEN/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('errores HTTP: red, sin JSON, 4xx/5xx y preferencia sin enlace', async () => {
    const g = gateway();
    const input = {
      paymentId: 'p',
      amount: 1,
      currency: 'PEN',
      idempotencyKey: 'k',
      description: 'x',
    };
    mockFetch(new Error('ECONNRESET'));
    await expect(g.createPayment(input)).rejects.toThrow(/no respondió/);
    mockFetch({ status: 502, text: '<html>' });
    await expect(g.createPayment(input)).rejects.toThrow(/sin JSON/);
    mockFetch({ status: 400, text: JSON.stringify({ error: 'bad_request' }) });
    await expect(g.createPayment(input)).rejects.toMatchObject({ providerCode: 'bad_request' });
    mockFetch({ id: 'pref' });
    await expect(g.createPayment(input)).rejects.toThrow(/sin enlace/);
    mockFetch({ id: 'pref', sandbox_init_point: 'https://sandbox/x' });
    expect((await g.createPayment(input)).clientAction.data.paymentUrl).toBe('https://sandbox/x');
  });

  it('consulta: elige el aprobado; pendiente o rechazado; sin pagos', async () => {
    const g = gateway();
    mockFetch({ results: [] });
    expect((await g.getPayment({ paymentId: 'p' })).status).toBe('PENDING');
    mockFetch({
      results: [{ id: 1, status: 'pending', external_reference: 'p', transaction_amount: 25 }],
    });
    expect((await g.getPayment({ paymentId: 'p' })).status).toBe('PENDING');
    mockFetch({
      results: [
        {
          id: 1,
          status: 'rejected',
          external_reference: 'p',
          transaction_amount: 25,
          live_mode: true,
        },
      ],
    });
    expect(await g.getPayment({ paymentId: 'p' })).toMatchObject({
      status: 'UNPAID',
      mode: 'PRODUCTION',
      providerData: undefined,
    });
    mockFetch({
      results: [
        { id: 1, status: 'rejected', external_reference: 'p', transaction_amount: 25 },
        {
          id: 2,
          status: 'approved',
          external_reference: 'p',
          transaction_amount: 25,
          currency_id: 'PEN',
          live_mode: false,
        },
        { id: 3, status: 'approved', external_reference: 'otro', transaction_amount: 99 },
      ],
    });
    expect(await g.getPayment({ paymentId: 'p' })).toMatchObject({
      status: 'PAID',
      amount: 2500,
      mode: 'TEST',
      providerData: { mpPaymentId: '2' },
    });
  });

  it('devolución y su estado', async () => {
    const g = gateway();
    const input = {
      refundId: 'r',
      paymentId: 'p',
      providerPaymentId: 'pref',
      amount: 1000,
      currency: 'PEN',
      idempotencyKey: 'rk',
    };
    await expect(g.refund({ ...input, providerData: null })).rejects.toThrow(/falta/);
    mockFetch({ status: 'approved' });
    await expect(g.refund({ ...input, providerData: { mpPaymentId: '7' } })).rejects.toThrow(
      /sin id/,
    );
    const spy = mockFetch({ id: 55, status: 'approved' });
    expect(await g.refund({ ...input, providerData: { mpPaymentId: '7' } })).toEqual({
      providerRefundId: '7:55',
      status: 'SUCCEEDED',
    });
    expect(spy.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify({ amount: 10 }) });
    expect(await g.getRefund({ providerRefundId: null })).toEqual({ status: 'NOT_FOUND' });
    expect(await g.getRefund({ providerRefundId: 'sin-separador' })).toEqual({
      status: 'NOT_FOUND',
    });
    mockFetch({ status: 404, text: '{"error":"not_found"}' });
    expect(await g.getRefund({ providerRefundId: '7:55' })).toEqual({ status: 'NOT_FOUND' });
    mockFetch({ status: 'rejected' });
    expect(await g.getRefund({ providerRefundId: '7:55' })).toEqual({ status: 'FAILED' });
    mockFetch({ status: 'in_process' });
    expect(await g.getRefund({ providerRefundId: '7:55' })).toEqual({ status: 'PENDING' });
  });

  it('webhook: firma, cuerpo y pagos sin referencia', async () => {
    const g = gateway();
    await expect(
      g.parseWebhook({ rawBody: Buffer.from('no-json'), headers: {} }),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    await expect(
      g.parseWebhook(signed('9', { type: 'payment', data: { id: '9' } }, 'otro')),
    ).rejects.toBeInstanceOf(InvalidSignatureError);
    mockFetch({ id: 9, status: 'approved' });
    expect(await g.parseWebhook(signed('9', { type: 'payment', data: { id: '9' } }))).toMatchObject(
      { ignored: true },
    );
    expect(() => g.verifyClientResult()).toThrow(InvalidSignatureError);
  });
});
