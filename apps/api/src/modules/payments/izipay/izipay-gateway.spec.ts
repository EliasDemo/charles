import { type AppConfig, IzipayMode, PaymentsGateway } from '../../../common/config/env.validation';
import { InvalidSignatureError, PaymentGatewayError } from '../payment-gateway';
import { IzipayGateway } from './izipay-gateway';
import { izipaySignature } from './izipay-protocol';

const HASH = 'clave-hash';

function gateway(
  overrides: Partial<AppConfig['payments']['izipay']> = {},
  publicApiUrl: string | null = 'https://api.charles.test',
) {
  const config = {
    crypto: { blindIndexKey: Buffer.alloc(32, 7) },
    payments: {
      gateway: PaymentsGateway.Izipay,
      publicApiUrl,
      izipay: {
        mode: IzipayMode.Test,
        merchantCode: '4007701',
        apiKey: 'api',
        hashKey: HASH,
        publicKey: 'rsa',
        ruc: '20100047218',
        apiUrl: 'https://izipay.test',
        checkoutScriptUrl: 'https://izipay.test/index.js',
        ...overrides,
      },
    },
  } as unknown as AppConfig;
  return new IzipayGateway(config, { now: () => 1_900_000_000_000 });
}

/** Respuestas de `fetch` en orden. */
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

const tokenOk = { code: '00', message: 'OK', response: { token: 't'.repeat(255) } };
const raw = (body: unknown) => ({
  rawBody: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  headers: {},
});

describe('IzipayGateway', () => {
  afterEach(() => jest.restoreAllMocks());

  it('enlace de pago: firmado, con vencimiento y para un solo pago', async () => {
    const g = gateway();
    const result = await g.createPayment({
      paymentId: 'p1',
      amount: 2500,
      currency: 'PEN',
      idempotencyKey: 'booking:b1',
      description: 'Corte',
    });
    expect(result.clientAction.type).toBe('IZIPAY_WEB');
    const url = new URL(result.clientAction.data.paymentUrl!);
    const [e, s] = [url.searchParams.get('e'), url.searchParams.get('s')];
    expect(g.isValidCheckoutLink('p1', e, s)).toBe(true);
    expect(g.isValidCheckoutLink('p2', e, s)).toBe(false);
    expect(g.isValidCheckoutLink('p1', '1', s)).toBe(false);
    expect(g.isValidCheckoutLink('p1', 'abc', s)).toBe(false);
    expect(g.isValidCheckoutLink('p1', e, 123)).toBe(false);
  });

  it('sin PUBLIC_API_URL no puede iniciar el pago', async () => {
    await expect(
      gateway({}, null).createPayment({
        paymentId: 'p1',
        amount: 1,
        currency: 'PEN',
        idempotencyKey: 'k',
        description: 'x',
      }),
    ).rejects.toBeInstanceOf(PaymentGatewayError);
  });

  it('errores de red, respuestas sin JSON, 5xx y token rechazado → PaymentGatewayError', async () => {
    const g = gateway();
    const session = () =>
      g.checkoutSession({ orderNumber: 'C00000000000001', amount: 2500, currency: 'PEN' });
    mockFetch(new Error('ECONNRESET'));
    await expect(session()).rejects.toThrow(/no respondió/);
    mockFetch({ status: 502, text: '<html>' });
    await expect(session()).rejects.toThrow(/sin JSON/);
    mockFetch({ status: 500, text: JSON.stringify({ code: 'E001' }) });
    await expect(session()).rejects.toMatchObject({ providerCode: 'E001' });
    mockFetch({ code: '400', message: 'Estructura del request inválida.' });
    await expect(session()).rejects.toThrow(/token/);
  });

  it('sin credenciales configuradas no llama a Izipay', async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    await expect(
      gateway({ merchantCode: null }).checkoutSession({
        orderNumber: 'C0001',
        amount: 1,
        currency: 'PEN',
      }),
    ).rejects.toThrow(/IZIPAY_MERCHANT_CODE/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('consulta: sin pedido, pedido sin pagos y respuesta sin firma válida', async () => {
    const g = gateway();
    expect((await g.getPayment({ paymentId: 'p', providerPaymentId: null })).status).toBe(
      'NOT_FOUND',
    );
    mockFetch(tokenOk, { code: 'O01', message: 'No encontrado' });
    expect((await g.getPayment({ paymentId: 'p', providerPaymentId: 'C0001' })).status).toBe(
      'PENDING',
    );
    mockFetch(tokenOk, { code: '00', payloadHttp: '{}', signature: 'falsa' });
    await expect(g.getPayment({ paymentId: 'p', providerPaymentId: 'C0001' })).rejects.toThrow(
      /firma/,
    );
    const payloadHttp = JSON.stringify({
      code: '00',
      response: { order: [{ orderNumber: 'OTRO', amount: '1.00' }] },
    });
    mockFetch(tokenOk, { code: '00', payloadHttp, signature: izipaySignature(payloadHttp, HASH) });
    expect((await g.getPayment({ paymentId: 'p', providerPaymentId: 'C0001' })).status).toBe(
      'NOT_FOUND',
    );
    const denied = JSON.stringify({
      code: '05',
      response: { order: [{ orderNumber: 'C0001', amount: '1.00', currency: 'PEN' }] },
    });
    mockFetch(tokenOk, {
      code: '00',
      payloadHttp: denied,
      signature: izipaySignature(denied, HASH),
    });
    expect(await g.getPayment({ paymentId: 'p', providerPaymentId: 'C0001' })).toMatchObject({
      status: 'UNPAID',
      amount: 100,
      providerData: undefined,
    });
  });

  it('devolución: exige los datos del pago y que Izipay la registre', async () => {
    const g = gateway();
    const input = {
      refundId: 'r',
      paymentId: 'p',
      providerPaymentId: 'C0001',
      amount: 1000,
      currency: 'PEN',
      idempotencyKey: 'k',
    };
    const spy = jest.spyOn(globalThis, 'fetch');
    await expect(g.refund({ ...input, providerData: null })).rejects.toThrow(/faltan/);
    await expect(g.refund({ ...input, providerData: { uniqueId: '1' } })).rejects.toThrow(/faltan/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const data = { uniqueId: '1', codeAuth: 'S1', referenceNumber: '7' };
    mockFetch(tokenOk, { code: 'R01', message: 'No permitido' });
    await expect(g.refund({ ...input, providerData: data })).rejects.toMatchObject({
      providerCode: 'R01',
    });
  });

  it('estado de devolución: sin id, inexistente, error y aprobado', async () => {
    const g = gateway();
    expect(await g.getRefund({ refundId: 'r', providerRefundId: null })).toEqual({
      status: 'NOT_FOUND',
    });
    mockFetch(tokenOk, { code: 'N01', message: 'No existe' });
    expect(await g.getRefund({ refundId: 'r', providerRefundId: '7001' })).toEqual({
      status: 'NOT_FOUND',
    });
    mockFetch(tokenOk, { code: 'RI2', message: 'Formato' });
    expect(await g.getRefund({ refundId: 'r', providerRefundId: '7001' })).toEqual({
      status: 'PENDING',
    });
    mockFetch(tokenOk, { code: '00', response: { statusName: 'RECHAZADO' } });
    expect(await g.getRefund({ refundId: 'r', providerRefundId: '7001' })).toEqual({
      status: 'FAILED',
    });
  });

  it('notificación y resultado: rechaza cuerpos sin JSON, sin firma o sin pedido', () => {
    const g = gateway();
    expect(() => g.parseWebhook(raw('no-json'))).toThrow(InvalidSignatureError);
    expect(() => g.parseWebhook(raw([1, 2]))).toThrow(InvalidSignatureError);
    const sinPedido = JSON.stringify({ code: '00', response: { order: [] } });
    expect(() =>
      g.parseWebhook(raw({ payloadHttp: sinPedido, signature: izipaySignature(sinPedido, HASH) })),
    ).toThrow(InvalidSignatureError);
    expect(() => g.verifyClientResult(raw('no-json'))).toThrow(InvalidSignatureError);
    const ok = JSON.stringify({
      code: '00',
      response: { order: [{ orderNumber: 'C0001', amount: '25.00' }] },
    });
    expect(
      g.verifyClientResult(raw({ payloadHttp: ok, signature: izipaySignature(ok, HASH) })),
    ).toEqual({
      paymentId: null,
      providerPaymentId: 'C0001',
    });
  });
});
