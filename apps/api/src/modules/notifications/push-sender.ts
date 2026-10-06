import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { AppConfig } from '../../common/config/env.validation';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

export const PUSH_SENDER = Symbol('PUSH_SENDER');

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Navegación: `{ type, resource }`. */
  data: Record<string, unknown>;
}

/** Resultado por mensaje, en el mismo orden. `DeviceNotRegistered` = token inválido (se borra). */
export type PushResult =
  { ok: true; ticketId: string } | { ok: false; error: string; permanent: boolean };

export type PushReceipt = { ok: true } | { ok: false; error: string };

/**
 * Envío de push (Fase 10). Expo en producción; simulado en desarrollo y pruebas. Si el proveedor
 * no responde, `send` lanza (reintento con espera); los errores por token van en el resultado.
 */
export interface PushSender {
  send(messages: PushMessage[]): Promise<PushResult[]>;
  /** Recibos de entrega de Expo (algunos tokens se marcan inválidos recién aquí). */
  receipts(ticketIds: string[]): Promise<Map<string, PushReceipt>>;
}

export const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

// ───────────── Simulado ─────────────

export const FAKE_PUSH_INBOX_KEY = 'fake-push:inbox';
const INBOX_MAX = 200;
const INBOX_TTL_SECONDS = 3600;

export interface StoredPush extends PushMessage {
  ticketId: string;
  sentAt: string;
}

/**
 * Push simulado (prohibido en producción): guarda los envíos en Redis. Un token que contiene
 * `Invalid` responde `DeviceNotRegistered`, como haría Expo. Nunca escribe tokens en los logs.
 */
@Injectable()
export class FakePushSender implements PushSender {
  private readonly logger = new Logger(FakePushSender.name);
  private unavailable = false;
  private readonly invalidReceipts = new Set<string>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Pruebas: simula que Expo no responde. */
  setUnavailable(value: boolean): void {
    this.unavailable = value;
  }

  /** Pruebas: el recibo de este envío dirá `DeviceNotRegistered`. */
  failReceipt(ticketId: string): void {
    this.invalidReceipts.add(ticketId);
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (this.unavailable) throw new Error('Push simulado no disponible');
    const results: PushResult[] = [];
    for (const message of messages) {
      if (message.to.includes('Invalid')) {
        results.push({ ok: false, error: DEVICE_NOT_REGISTERED, permanent: true });
        continue;
      }
      const ticketId = `fake_push_${crypto.randomUUID()}`;
      const stored: StoredPush = { ...message, ticketId, sentAt: new Date().toISOString() };
      await this.redis
        .multi()
        .lpush(FAKE_PUSH_INBOX_KEY, JSON.stringify(stored))
        .ltrim(FAKE_PUSH_INBOX_KEY, 0, INBOX_MAX - 1)
        .expire(FAKE_PUSH_INBOX_KEY, INBOX_TTL_SECONDS)
        .exec();
      results.push({ ok: true, ticketId });
    }
    this.logger.log({ count: messages.length }, 'Push simulado guardado en Redis');
    return results;
  }

  receipts(ticketIds: string[]): Promise<Map<string, PushReceipt>> {
    return Promise.resolve(
      new Map(
        ticketIds.map((id) => [
          id,
          this.invalidReceipts.has(id) ? { ok: false, error: DEVICE_NOT_REGISTERED } : { ok: true },
        ]),
      ),
    );
  }

  async inbox(): Promise<StoredPush[]> {
    const raw = await this.redis.lrange(FAKE_PUSH_INBOX_KEY, 0, -1);
    return raw.map((item) => JSON.parse(item) as StoredPush);
  }
}

// ───────────── Expo ─────────────

const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_CHUNK = 100;
const TIMEOUT_MS = 10_000;
/** Errores de Expo que no se arreglan reintentando. */
const PERMANENT_ERRORS = new Set([DEVICE_NOT_REGISTERED, 'MessageTooBig', 'InvalidCredentials']);

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  details?: { error?: string };
}

/**
 * Expo Push Service. Las credenciales de Firebase (Android) y Apple (iOS) se configuran en el
 * proyecto de Expo, no aquí; `EXPO_ACCESS_TOKEN` solo si el proyecto exige token.
 */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly config: AppConfig,
    private readonly http: typeof fetch = fetch,
  ) {}

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (let i = 0; i < messages.length; i += EXPO_CHUNK) {
      const chunk = messages.slice(i, i + EXPO_CHUNK).map((m) => ({
        to: m.to,
        title: m.title,
        body: m.body,
        data: m.data,
        sound: 'default',
      }));
      const response = await this.post<{ data: ExpoTicket[] }>(EXPO_SEND_URL, chunk);
      for (const ticket of response.data) {
        if (ticket.status === 'ok' && ticket.id) {
          results.push({ ok: true, ticketId: ticket.id });
        } else {
          const error = ticket.details?.error ?? 'Unknown';
          results.push({ ok: false, error, permanent: PERMANENT_ERRORS.has(error) });
        }
      }
    }
    return results;
  }

  async receipts(ticketIds: string[]): Promise<Map<string, PushReceipt>> {
    const result = new Map<string, PushReceipt>();
    for (let i = 0; i < ticketIds.length; i += 1000) {
      const response = await this.post<{ data: Record<string, ExpoTicket> }>(EXPO_RECEIPTS_URL, {
        ids: ticketIds.slice(i, i + 1000),
      });
      for (const [id, receipt] of Object.entries(response.data)) {
        result.set(
          id,
          receipt.status === 'ok'
            ? { ok: true }
            : { ok: false, error: receipt.details?.error ?? 'Unknown' },
        );
      }
    }
    return result;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (this.config.push.expoAccessToken) {
      headers.authorization = `Bearer ${this.config.push.expoAccessToken}`;
    }
    const response = await this.http(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Expo respondió ${response.status}`);
    return (await response.json()) as T;
  }
}
