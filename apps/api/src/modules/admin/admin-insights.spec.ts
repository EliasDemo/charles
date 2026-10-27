import { AdminInsightsService } from './admin-insights';

/** Salud del sistema en los casos que el e2e no alcanza (caídas, lentitud, colas con fallos). */
describe('AdminInsightsService.health', () => {
  function build(options: {
    db?: 'ok' | 'down';
    redis?: 'ok' | 'down';
    storage?: boolean;
    failedJobs?: number;
    counts?: Partial<Record<'outbox' | 'notif' | 'payments' | 'refunds', number>>;
  }) {
    const c = options.counts ?? {};
    const prisma = {
      $queryRaw: jest.fn(() =>
        options.db === 'down' ? Promise.reject(new Error('db')) : Promise.resolve([1]),
      ),
      outboxEvent: { count: jest.fn().mockResolvedValue(c.outbox ?? 0) },
      notification: { count: jest.fn().mockResolvedValue(c.notif ?? 0) },
      payment: { count: jest.fn().mockResolvedValue(c.payments ?? 0) },
      refund: { count: jest.fn().mockResolvedValue(c.refunds ?? 0) },
    };
    const exec = jest.fn().mockResolvedValue([
      [null, 1],
      [null, 0],
      [null, 2],
      [null, options.failedJobs ?? 0],
    ]);
    const chain = { llen: () => chain, zcard: () => chain, zcount: () => chain, exec };
    const redis = {
      ping: jest.fn(() =>
        options.redis === 'down' ? Promise.reject(new Error('redis')) : Promise.resolve('PONG'),
      ),
      multi: jest.fn(() => chain),
    };
    return new AdminInsightsService(
      prisma as never,
      {} as never,
      {} as never,
      redis as never,
      { enabled: options.storage ?? true } as never,
      { now: () => Date.parse('2030-01-07T15:00:00Z') },
    );
  }

  it('todo en orden: OK, con las colas y la versión', async () => {
    const h = await build({}).health();
    expect(h.status).toBe('OK');
    expect(h.queues.length).toBeGreaterThan(5);
    expect(h.queues[0]).toEqual({ name: 'outbox', waiting: 1, active: 0, delayed: 2, failed: 0 });
    expect(h.checks.find((x) => x.name === 'Colas de trabajo')?.status).toBe('OK');
  });

  it('colas con fallos, fotos sin configurar y atrasos: WARN con el detalle', async () => {
    const h = await build({
      storage: false,
      failedJobs: 3,
      counts: { outbox: 2, notif: 30, payments: 1 },
    }).health();
    expect(h.status).toBe('WARN');
    const by = (n: string) => h.checks.find((x) => x.name === n)!;
    expect(by('Colas de trabajo').detail).toContain('outbox (3)');
    expect(by('Almacenamiento de fotos').status).toBe('WARN');
    expect(by('Eventos internos (outbox)').status).toBe('WARN');
    expect(by('Notificaciones').status).toBe('WARN');
    expect(by('Pagos y reembolsos').status).toBe('WARN');
  });

  it('base o Redis caídos: DOWN y sin colas', async () => {
    const db = await build({ db: 'down' }).health();
    expect(db.status).toBe('DOWN');
    expect(db.checks[0]).toMatchObject({
      name: 'Base de datos',
      status: 'DOWN',
      detail: 'Sin conexión',
    });
    const redis = await build({ redis: 'down' }).health();
    expect(redis.status).toBe('DOWN');
    expect(redis.queues).toEqual([]);
    expect(redis.checks.some((x) => x.name === 'Colas de trabajo')).toBe(false);
  });
});
