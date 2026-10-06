import type { NestExpressApplication } from '@nestjs/platform-express';
import { IdempotentConsumerStore } from '../../src/common/outbox/idempotent-consumer';
import { OutboxDispatcher } from '../../src/common/outbox/outbox.dispatcher';
import {
  OUTBOX_MAX_ATTEMPTS,
  OutboxRelay,
  retryDelaySeconds,
} from '../../src/common/outbox/outbox.relay';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import type { OutboxMessage } from '../../src/common/outbox/outbox.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createAuthTestApp } from '../support/auth';

describe('C: outbox transaccional, entrega "al menos una vez" (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let relay: OutboxRelay;
  const received: OutboxMessage[] = [];
  const effects: string[] = [];
  let failures = 0;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
    relay = app.get(OutboxRelay);
    const store = app.get(IdempotentConsumerStore);
    // Consumidor de prueba idempotente por ID de evento (como debe ser todo consumidor).
    app.get(OutboxDispatcher).register({
      name: 'test-consumer',
      types: ['test.ping', 'test.fails'],
      handle: async (message) => {
        received.push(message);
        if (message.type === 'test.fails' && failures-- > 0) throw new Error('fallo simulado');
        await store.runOnce('test-consumer', message.id, () => {
          effects.push(message.id);
          return Promise.resolve();
        });
      },
    });
  });
  beforeEach(async () => {
    received.length = 0;
    effects.length = 0;
    failures = 0;
    await prisma.outboxEvent.deleteMany();
  });
  afterAll(() => app.close());

  const publish = (type: string, payload: Record<string, string> = {}) =>
    prisma.$transaction((tx) => app.get(OutboxService).publish(tx, type, payload));

  it('publica dentro de la transacción: si se revierte, el evento no existe', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await app.get(OutboxService).publish(tx, 'test.ping', {});
        throw new Error('revertir');
      }),
    ).rejects.toThrow('revertir');
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it('entrega los pendientes con un ID único y los marca procesados', async () => {
    const a = await publish('test.ping', { n: '1' });
    const b = await publish('test.ping', { n: '2' });
    expect(a).not.toBe(b);
    expect(await relay.relayBatch()).toBe(2);
    expect(received.map((m) => [m.id, m.payload, m.attempt])).toEqual([
      [a, { n: '1' }, 1],
      [b, { n: '2' }, 1],
    ]);
    const rows = await prisma.outboxEvent.findMany();
    expect(rows.every((r) => r.status === 'PROCESSED' && r.processedAt)).toBe(true);
    expect(await relay.relayBatch()).toBe(0);
  });

  it('C: entrega duplicada: el consumidor idempotente aplica el efecto una sola vez', async () => {
    const id = await publish('test.ping');
    await relay.relayBatch();
    // Simula una reentrega (por ejemplo, el relay cayó antes de marcarlo procesado).
    await prisma.outboxEvent.update({ where: { id }, data: { status: 'PENDING' } });
    await relay.relayBatch();
    expect(received.map((m) => m.id)).toEqual([id, id]);
    expect(effects).toEqual([id]);
    expect(await app.get(IdempotentConsumerStore).wasProcessed('test-consumer', id)).toBe(true);
  });

  it('si el consumidor falla se reintenta con espera; tras el máximo de intentos queda FAILED', async () => {
    const id = await publish('test.fails');
    failures = 100;
    await relay.relayBatch();
    let row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    // Aún no toca reintentar.
    expect(await relay.relayBatch()).toBe(0);

    await prisma.outboxEvent.update({
      where: { id },
      data: { attempts: OUTBOX_MAX_ATTEMPTS - 1, availableAt: new Date(0) },
    });
    await relay.relayBatch();
    row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'FAILED', attempts: OUTBOX_MAX_ATTEMPTS });
    expect(effects).toEqual([]);
  });

  it('un fallo transitorio se recupera en el reintento y el efecto se aplica una vez', async () => {
    const id = await publish('test.fails');
    failures = 1;
    await relay.relayBatch();
    await prisma.outboxEvent.update({ where: { id }, data: { availableAt: new Date(0) } });
    await relay.relayBatch();
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
      'PROCESSED',
    );
    expect(effects).toEqual([id]);
  });

  it('un evento "en proceso" abandonado (relay caído) se reentrega', async () => {
    const id = await publish('test.ping');
    await prisma.$executeRaw`UPDATE outbox_events SET status = 'PROCESSING',
      updated_at = now() - interval '10 minutes' WHERE id = ${id}::uuid`;
    expect(await relay.relayBatch()).toBe(1);
    expect(effects).toEqual([id]);
  });

  it('dos relays a la vez no entregan el mismo lote dos veces', async () => {
    for (let i = 0; i < 20; i++) await publish('test.ping', { n: String(i) });
    const [a, b] = await Promise.all([relay.relayBatch(), relay.relayBatch()]);
    expect(a + b).toBe(20);
    expect(new Set(received.map((m) => m.id)).size).toBe(20);
    expect(received).toHaveLength(20);
  });

  it('espera creciente con tope', () => {
    expect([1, 2, 3, 20].map(retryDelaySeconds)).toEqual([2, 4, 8, 600]);
  });

  it('no se puede registrar dos consumidores con el mismo nombre', () => {
    expect(() =>
      app
        .get(OutboxDispatcher)
        .register({ name: 'test-consumer', types: [], handle: () => Promise.resolve() }),
    ).toThrow(/duplicado/);
  });
});
