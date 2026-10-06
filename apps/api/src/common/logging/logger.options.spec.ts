import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import { LogLevel } from '../config/env.validation';
import { buildPinoOptions, maskUrl, REDACTED, resolveRequestId } from './logger.options';

function captureLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = pino(buildPinoOptions({ logLevel: LogLevel.Info }), stream);
  return {
    logger,
    lines: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>),
  };
}

describe('enmascarado de logs', () => {
  it('oculta credenciales y datos personales a varios niveles de profundidad', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        password: 'p1',
        user: { email: 'persona@example.com', phone: '999', name: 'visible' },
        data: { auth: { refreshToken: 't1' } },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: 'json' } },
        payment: { body: { cardNumber: '4111' } },
      },
      'evento',
    );
    const [line] = lines();
    const raw = JSON.stringify(line);
    for (const secret of [
      'p1',
      'persona@example.com',
      '"999"',
      't1',
      'Bearer abc',
      'sid=1',
      '4111',
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(line).toMatchObject({
      password: REDACTED,
      user: { email: REDACTED, phone: REDACTED, name: 'visible' },
      req: { headers: { authorization: REDACTED, accept: 'json' } },
    });
  });
});

describe('maskUrl', () => {
  it('enmascara parámetros sensibles y conserva los demás', () => {
    expect(maskUrl('/api/v1/x?token=abc&page=2&Email=a@b.com')).toBe(
      '/api/v1/x?token=%5BREDACTED%5D&page=2&Email=%5BREDACTED%5D',
    );
  });

  it('RF-BUS-002: la ubicación del cliente y el cursor de búsqueda no llegan a los logs', () => {
    const masked = maskUrl(
      '/api/v1/search/barbershops?lat=-12.1211&lng=-77.0297&q=corte&cursor=abc',
    );
    expect(masked).toBe(
      '/api/v1/search/barbershops?lat=%5BREDACTED%5D&lng=%5BREDACTED%5D&q=corte&cursor=%5BREDACTED%5D',
    );
    expect(masked).not.toContain('12.12');
    expect(masked).not.toContain('77.02');
  });

  it('no modifica URLs sin query', () => {
    expect(maskUrl('/api/v1/health')).toBe('/api/v1/health');
    expect(maskUrl(undefined)).toBeUndefined();
  });
});

describe('resolveRequestId', () => {
  function call(header?: string, existing?: unknown) {
    const req = {
      headers: header ? { 'x-request-id': header } : {},
      id: existing,
    } as unknown as IncomingMessage & { id?: unknown };
    const res = { setHeader: jest.fn() } as unknown as ServerResponse & { setHeader: jest.Mock };
    return { id: resolveRequestId(req, res), req, res };
  }

  it('reutiliza un ID entrante seguro y lo devuelve en la cabecera', () => {
    const { id, req, res } = call('abc-123_x.y');
    expect(id).toBe('abc-123_x.y');
    expect(req.id).toBe('abc-123_x.y');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'abc-123_x.y');
  });

  it.each(['con espacios', 'a\nb', 'x'.repeat(129), '<script>'])(
    'genera uno nuevo si es %p',
    (h) => {
      expect(call(h).id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('respeta un ID ya asignado a la petición', () => {
    const { id, res } = call('otro', 'ya-asignado');
    expect(id).toBe('ya-asignado');
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
