import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { izipaySignature } from '../../src/modules/payments/izipay/izipay-protocol';

/**
 * Izipay simulado para las e2e (Fase 8B): un servidor HTTP local con los endpoints que usa
 * Charles, según la especificación de developers.izipay.pe (token de sesión, consulta de pedido,
 * devolución y estado de devolución). Firma como el real: HMAC-SHA256 de `payloadHttp` con la
 * clave hash, en base64. Credenciales aleatorias por ejecución (nunca en el repositorio).
 */
export class IzipaySimulator {
  readonly merchantCode = '4007701';
  readonly apiKey = randomBytes(16).toString('hex');
  readonly hashKey = randomBytes(24).toString('hex');
  readonly publicKey = `-----BEGIN PUBLIC KEY-----\n${randomBytes(32).toString('base64')}\n-----END PUBLIC KEY-----`;
  readonly ruc = '20100047218';

  private server: Server | null = null;
  private readonly tokens = new Map<string, { requestSource: string; orderNumber: string }>();
  /** Pedidos pagados en el "lado de Izipay": número de pedido → resultado firmado. */
  private readonly paid = new Map<string, { amount: string; code: string; uniqueId: string }>();
  readonly refunds: { body: Record<string, unknown>; requestSource: string }[] = [];
  refundStatusName = 'AUTORIZADO';
  /** Respuestas forzadas para probar caídas. */
  unavailable = false;
  readonly calls: string[] = [];

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

  /** Sobre firmado como el que envía Izipay (notificación, regreso del formulario o consulta). */
  signedResult(input: {
    orderNumber: string;
    amount: string;
    code?: string;
    transactionId?: string;
    payMethod?: 'CARD' | 'YAPE_CODE';
    uniqueId?: string;
  }): { code: string; payloadHttp: string; signature: string; transactionId: string } {
    const code = input.code ?? '00';
    const transactionId = input.transactionId ?? `${Date.now()}${randomBytes(2).readUInt16BE(0)}`;
    const payMethod = input.payMethod ?? 'CARD';
    const payload = {
      code,
      message: code === '00' ? 'Operación exitosa' : 'Denegado',
      messageUser: code === '00' ? 'Operación exitosa' : 'Denegado',
      messageUserEng: code === '00' ? 'Successful' : 'Denied',
      transactionId,
      response: {
        payMethod,
        order: [
          {
            payMethodAuthorization: payMethod,
            codeAuth: 'S93925',
            currency: 'PEN',
            amount: input.amount,
            installment: '00',
            deferred: '0',
            orderNumber: input.orderNumber,
            stateMessage: code === '00' ? 'Autorizado' : 'Denegado',
            dateTransaction: '20300107',
            timeTransaction: '111451',
            uniqueId: input.uniqueId ?? '1286134',
            referenceNumber: '7000000',
          },
        ],
        card: { brand: 'VS', pan: '497010******0055', save: 'false' },
        merchant: { merchantCode: this.merchantCode, facilitatorCode: '' },
      },
    };
    const payloadHttp = JSON.stringify(payload);
    return {
      code,
      payloadHttp,
      signature: izipaySignature(payloadHttp, this.hashKey),
      transactionId,
    };
  }

  /** El cliente pagó en el formulario: la consulta del pedido lo verá aprobado. */
  markPaid(orderNumber: string, amount: string, code = '00'): void {
    this.paid.set(orderNumber, { amount, code, uniqueId: '1286134' });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    this.calls.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (this.unavailable) return send(500, { code: '500', message: 'Error interno', response: {} });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      : {};
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const session = auth ? this.tokens.get(auth) : undefined;
    if (!req.headers.transactionid)
      return send(400, { code: '400', message: 'Falta transactionId', response: {} });

    if (url.pathname === '/security/v1/Token/Generate') {
      if (body.publicKey !== this.apiKey || body.merchantCode !== this.merchantCode) {
        return send(401, { code: '401', message: 'Credenciales inválidas', response: {} });
      }
      if (
        !/^\d+\.\d{2}$/.test(String(body.amount)) ||
        !/^.{5,15}$/.test(String(body.orderNumber))
      ) {
        return send(400, {
          code: '400',
          message: 'Estructura del request inválida.',
          response: {},
        });
      }
      const token = `tok_${randomBytes(140).toString('hex')}`;
      this.tokens.set(token, {
        requestSource: String(body.requestSource),
        orderNumber: String(body.orderNumber),
      });
      return send(200, { code: '00', message: 'OK', response: { token } });
    }
    if (!session)
      return send(401, { code: '401', message: 'ApiTokenValidate: Token expirado.', response: {} });

    if (url.pathname === '/orderinfo/v1/Transaction/Search') {
      const paid = this.paid.get(String(body.numberOrden));
      if (!paid) return send(200, { code: 'O01', message: 'Pedido no encontrado', response: {} });
      return send(200, {
        ...this.signedResult({
          orderNumber: String(body.numberOrden),
          amount: paid.amount,
          code: paid.code,
        }),
        message: 'Pago aceptado',
      });
    }
    if (url.pathname === '/refund/v1/Transaction/Refund') {
      if (session.requestSource !== 'REFUND' || body.ruc !== this.ruc) {
        return send(400, { code: '400', message: 'Solicitud inválida', response: {} });
      }
      this.refunds.push({ body, requestSource: session.requestSource });
      return send(200, {
        code: '00',
        message: 'La devolución fue registrada',
        response: {
          merchantCode: this.merchantCode,
          ruc: this.ruc,
          result: { refundTransactionId: `${7000 + this.refunds.length}` },
        },
      });
    }
    if (url.pathname === '/refund/v1/refunds/status') {
      const id = Number(url.searchParams.get('refundId'));
      if (!Number.isInteger(id) || id <= 7000 || id > 7000 + this.refunds.length) {
        return send(404, {
          code: 'N01',
          message: 'El id de la devolucion no existe',
          response: {},
        });
      }
      return send(200, {
        code: '00',
        message: 'Operación exitosa',
        response: { statusCode: '50', statusName: this.refundStatusName },
      });
    }
    return send(404, { code: '404', message: 'No existe', response: {} });
  }
}
