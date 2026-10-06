import { FakeGateway } from './fake-gateway';
import { paymentProviderErrors, PaymentsProviderCheck } from './payments-provider.check';
import { testOnlyModules, PaymentsTestingModule } from './testing/payments-testing.module';

describe('B: pasarela simulada nunca en producción', () => {
  it.each<[boolean, unknown, string, number]>([
    [true, 'FAKE', 'FAKE', 1],
    [true, null, 'FAKE', 1], // sin configurar = FAKE
    [true, 'IZIPAY', 'FAKE', 1], // la implementación activa sigue siendo la simulada
    [true, 'IZIPAY', 'IZIPAY', 0],
    [false, 'FAKE', 'FAKE', 0],
  ])('producción=%p, ajuste=%p, pasarela=%p → %p errores', (prod, setting, gateway, count) => {
    expect(paymentProviderErrors(prod, setting, gateway)).toHaveLength(count);
  });

  it('la validación de arranque falla en producción con el proveedor FAKE', async () => {
    const check = new PaymentsProviderCheck(
      { isProduction: true } as never,
      { get: () => Promise.resolve('FAKE') } as never,
      new FakeGateway(),
    );
    await expect(check.onApplicationBootstrap()).rejects.toThrow(/FAKE/);
  });

  it('fuera de producción no consulta nada ni falla', async () => {
    const get = jest.fn();
    const check = new PaymentsProviderCheck(
      { isProduction: false } as never,
      { get } as never,
      new FakeGateway(),
    );
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('el módulo de pruebas del pago solo se registra con NODE_ENV=test', () => {
    expect(testOnlyModules('test')).toEqual([PaymentsTestingModule]);
    for (const env of ['production', 'development', undefined]) {
      expect(testOnlyModules(env)).toEqual([]);
    }
  });
});

describe('FakeGateway', () => {
  const input = {
    paymentId: 'p1',
    amount: 2500,
    currency: 'PEN',
    idempotencyKey: 'booking:b1',
    description: 'Corte',
  };

  it('idempotente: la misma clave da el mismo identificador del proveedor', async () => {
    const gateway = new FakeGateway();
    const a = await gateway.createPayment(input);
    const b = await gateway.createPayment(input);
    expect(a.providerPaymentId).toBe(b.providerPaymentId);
    expect(a.providerPaymentId).toMatch(/^fake_[0-9a-f]{24}$/);
    const other = await gateway.createPayment({ ...input, idempotencyKey: 'booking:b2' });
    expect(other.providerPaymentId).not.toBe(a.providerPaymentId);
  });

  it('puede simular caídas para probar los reintentos', async () => {
    const gateway = new FakeGateway();
    gateway.failNextCalls(1);
    await expect(gateway.createPayment(input)).rejects.toThrow();
    await expect(gateway.createPayment(input)).resolves.toBeDefined();
  });
});
