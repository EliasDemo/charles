import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MercadoPagoPayment } from '../../src/modules/payments/mercadopago/mercadopago-gateway';

/**
 * Mercado Pago simulado para las e2e: preferencias, pagos, búsqueda y devoluciones, según la
 * documentación de Checkout Pro y la API de pagos. Los webhooks se firman como el SDK oficial
 * (`id:{data.id};request-id:{x-request-id};ts:{ts};`, HMAC-SHA256 hex). Credenciales aleatorias.
 */
export class MercadoPagoSimulator {
  readonly accessToken = `APP_USR-${randomBytes(16).toString('hex')}`;
  readonly webhookSecret = randomBytes(24).toString('hex');

  private server: Server | null = null;
  readonly preferences: Record<string, unknown>[] = [];
  readonly idempotencyKeys: string[] = [];
  private readonly payments = new Map<string, MercadoPagoPayment>();
  private readonly refunds = new Map<string, { id: number; status: string; amount: number }>();
  refundStatus = 'approved';
  unavailable = false;
  private nextId = 1_000_000;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /** El comprador pagó (o quedó pendiente / rechazado) en Checkout Pro. Devuelve el id del pago. */
  pay(input: {
    externalReference: string;
    amount: number;
    status?: string;
    liveMode?: boolean;
    method?: string;
  }): string {
    const id = String(this.nextId++);
    this.payments.set(id, {
      id: Number(id),
      status: input.status ?? 'approved',
      status_detail: input.status === 'rejected' ? 'cc_rejected_other_reason' : 'accredited',
      transaction_amount: input.amount,
      currency_id: 'PEN',
      external_reference: input.externalReference,
      live_mode: input.liveMode ?? false,
      payment_method_id: input.method ?? 'visa',
      payment_type_id: input.method === 'yape' ? 'bank_transfer' : 'credit_card',
    });
    return id;
  }

  setStatus(paymentId: string, status: string): void {
    this.payments.get(paymentId)!.status = status;
  }

  /** Webhook firmado como lo envía Mercado Pago. */
  webhook(dataId: string, type = 'payment', secret = this.webhookSecret) {
    const ts = String(Math.floor(Date.now() / 1000));
    const requestId = randomUUID();
    const v1 = createHmac('sha256', secret)
      .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
      .digest('hex');
    return {
      headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
      body: {
        id: randomBytes(4).readUInt32BE(0),
        live_mode: false,
        type,
        date_created: new Date().toISOString(),
        user_id: 44444,
        api_version: 'v1',
        action: `${type}.updated`,
        data: { id: dataId },
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (this.unavailable) {
      return send(500, { message: 'internal_error', error: 'internal_error', status: 500 });
    }
    if (req.headers.authorization !== `Bearer ${this.accessToken}`) {
      return send(401, { message: 'invalid access token', error: 'unauthorized', status: 401 });
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      : {};
    const key = req.headers['x-idempotency-key'];
    if (typeof key === 'string') this.idempotencyKeys.push(key);
    const notFound = () => send(404, { message: 'not found', error: 'not_found', status: 404 });

    if (req.method === 'POST' && url.pathname === '/checkout/preferences') {
      this.preferences.push(body);
      const id = `724484980-${randomUUID()}`;
      return send(201, {
        id,
        init_point: `https://www.mercadopago.com.pe/checkout/v1/redirect?pref_id=${id}`,
        sandbox_init_point: `https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=${id}`,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/payments/search') {
      const ref = url.searchParams.get('external_reference');
      const results = [...this.payments.values()]
        .filter((p) => p.external_reference === ref)
        .reverse();
      return send(200, { paging: { total: results.length }, results });
    }
    const refundMatch = /^\/v1\/payments\/(\d+)\/refunds(?:\/(\d+))?$/.exec(url.pathname);
    if (refundMatch) {
      const payment = this.payments.get(refundMatch[1]!);
      if (!payment) return notFound();
      if (req.method === 'POST') {
        const id = this.nextId++;
        const refund = {
          id,
          status: this.refundStatus,
          amount: Number(body.amount ?? payment.transaction_amount),
        };
        this.refunds.set(`${refundMatch[1]}:${id}`, refund);
        return send(201, { ...refund, payment_id: payment.id });
      }
      const refund = this.refunds.get(`${refundMatch[1]}:${refundMatch[2]}`);
      return refund ? send(200, refund) : notFound();
    }
    const paymentMatch = /^\/v1\/payments\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && paymentMatch) {
      const payment = this.payments.get(paymentMatch[1]!);
      return payment ? send(200, payment) : notFound();
    }
    return notFound();
  }
}
