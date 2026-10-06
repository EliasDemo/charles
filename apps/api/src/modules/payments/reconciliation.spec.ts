import { PaymentsProcessor, PaymentsScheduler, ReconciliationService } from './reconciliation';

describe('Conciliación: programación de los trabajos (Fase 8A, ajuste B)', () => {
  const build = (enabled: boolean, minutes: number | null) => {
    const queue = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };
    const settings = {
      positiveInt: jest.fn((_key: string, fallback: number) =>
        Promise.resolve(minutes ?? fallback),
      ),
    };
    const scheduler = new PaymentsScheduler(
      queue as never,
      { scheduledJobsEnabled: enabled } as never,
      settings as never,
    );
    return { scheduler, queue, settings };
  };

  it('revisión rápida cada N minutos (ajuste) y diaria a las 04:00 de Lima', async () => {
    const { scheduler, queue } = build(true, 5);
    await scheduler.onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'reconcile-quick',
      { every: 5 * 60_000 },
      expect.objectContaining({ name: 'reconcile-quick' }),
    );
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'reconcile-daily',
      { pattern: '0 4 * * *', tz: 'America/Lima' },
      expect.objectContaining({ name: 'reconcile-daily' }),
    );
  });

  it('por defecto, cada 2 minutos', async () => {
    const { scheduler, queue } = build(true, null);
    await scheduler.onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'reconcile-quick',
      { every: 2 * 60_000 },
      expect.anything(),
    );
  });

  it('con los trabajos programados apagados no programa nada', async () => {
    const { scheduler, queue, settings } = build(false, 5);
    await scheduler.onApplicationBootstrap();
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(settings.positiveInt).not.toHaveBeenCalled();
  });

  it('el procesador ejecuta la revisión que corresponde al trabajo', async () => {
    const reconciliation = {
      runQuick: jest.fn().mockResolvedValue({}),
      runDaily: jest.fn().mockResolvedValue({}),
    };
    const processor = new PaymentsProcessor(reconciliation as unknown as ReconciliationService);
    await processor.process({ name: 'reconcile-daily' } as never);
    await processor.process({ name: 'reconcile-quick' } as never);
    expect(reconciliation.runDaily).toHaveBeenCalledTimes(1);
    expect(reconciliation.runQuick).toHaveBeenCalledTimes(1);
  });
});

describe('ReconciliationService (casos límite)', () => {
  const pendingPayment = {
    id: 'p1',
    status: 'PENDING',
    amount: 2500,
    currency: 'PEN',
    providerPaymentId: 'x',
  };

  function build(options: {
    isProduction?: boolean;
    payment?: unknown;
    refund?: unknown;
    gateway?: Partial<Record<'getPayment' | 'getRefund', jest.Mock>>;
    paymentPages?: { id: string }[][];
  }) {
    const pages = [...(options.paymentPages ?? [])];
    const prisma = {
      payment: {
        findUnique: jest.fn().mockResolvedValue(options.payment ?? null),
        findMany: jest.fn(() => Promise.resolve(pages.shift() ?? [])),
      },
      refund: {
        findUnique: jest.fn().mockResolvedValue(options.refund ?? null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ReconciliationService(
      prisma as never,
      { executeRefund: jest.fn() } as never,
      audit as never,
      { getPayment: jest.fn(), getRefund: jest.fn(), ...options.gateway } as never,
      { isProduction: options.isProduction ?? false } as never,
      { now: () => Date.parse('2030-01-07T15:00:00Z') },
    );
    return { service, prisma, audit };
  }

  it('en producción, un pago pagado en modo TEST no se confirma: queda para revisión', async () => {
    const { service, audit } = build({
      isProduction: true,
      payment: pendingPayment,
      gateway: {
        getPayment: jest.fn().mockResolvedValue({
          status: 'PAID',
          amount: 2500,
          currency: 'PEN',
          mode: 'TEST',
          providerTransactionId: 't',
        }),
      },
    });
    expect(await service.checkPayment('p1')).toBe('REVIEW');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.reconciliation_review' }),
    );
  });

  it('la consulta de un reembolso enviado falla: UNAVAILABLE, sin cambios', async () => {
    const { service } = build({
      refund: { id: 'r1', status: 'PENDING', requestedAt: new Date(), providerRefundId: 'x' },
      gateway: { getRefund: jest.fn().mockRejectedValue(new Error('caída')) },
    });
    expect(await service.checkRefund('r1')).toBe('UNAVAILABLE');
  });

  it('reembolso aún pendiente en la pasarela: sin cambios', async () => {
    const { service } = build({
      refund: { id: 'r1', status: 'PENDING', requestedAt: new Date(), providerRefundId: 'x' },
      gateway: { getRefund: jest.fn().mockResolvedValue({ status: 'PENDING' }) },
    });
    expect(await service.checkRefund('r1')).toBe('UNCHANGED');
  });

  it('la revisión diaria recorre todas las páginas (no solo las primeras 100)', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_v, i) => ({ id: `p${from + i}` }));
    const { service, prisma } = build({
      paymentPages: [page(0, 100), page(100, 100), page(200, 7)],
    });
    const totals = await service.runDaily();
    // Los pagos no existen en el doble de prueba: cada uno da UNCHANGED.
    expect(totals.UNCHANGED).toBe(207);
    expect(prisma.payment.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.payment.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { gt: 'p199' } }) }),
    );
  });

  it('un error inesperado en un elemento del lote no detiene a los demás', async () => {
    const { service, prisma } = build({ paymentPages: [[{ id: 'a' }, { id: 'b' }]] });
    prisma.payment.findUnique
      .mockRejectedValueOnce(new Error('base caída'))
      .mockResolvedValueOnce(null);
    const totals = await service.runQuick();
    expect(totals).toEqual({ CONFIRMED: 0, REVIEW: 0, UNCHANGED: 1, UNAVAILABLE: 1 });
  });
});
