import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Limita por la IP real del cliente. `req.ip` la resuelve Express a partir de
 * `X-Forwarded-For` confiando solo en los proxies de TRUST_PROXY, por lo que un
 * cliente no puede evadir el límite falsificando esa cabecera.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(clientIpOf(req as unknown as Request));
  }
}

export function clientIpOf(req: Pick<Request, 'ip' | 'socket'>): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
