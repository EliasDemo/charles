import { appliesTo, parseRules, type PromotionCandidate } from '../promotions/discount-policy';
import { normalizeEntitlement, hasFeature, limitOf } from '../plans/entitlements';
import {
  FakeInvoiceProvider,
  InvoiceProviderError,
  NubefactInvoiceProvider,
  taxIncluded,
} from './invoice-provider';
import { discounted } from './sales.service';
import { rankingScore, tierFor } from './shop-clients.service';

/** Cuerpo JSON enviado en una llamada a `fetch` simulada. */
function sentBody(init: unknown): Record<string, unknown> {
  return JSON.parse((init as { body: string }).body) as Record<string, unknown>;
}

const DAY = 86_400_000;

describe('Beneficios del plan', () => {
  it('límites e interruptores; sin planes, todo ilimitado', () => {
    const values = new Map<string, number | null>([
      ['barbers', 2],
      ['messages_month', null],
      ['promotions', 1],
      ['memberships', 0],
    ]);
    expect(limitOf(values, 'barbers')).toBe(2);
    expect(limitOf(values, 'messages_month')).toBeNull();
    expect(limitOf(values, 'crm_clients')).toBe(0);
    expect(limitOf(null, 'barbers')).toBeNull();
    expect(hasFeature(values, 'promotions')).toBe(true);
    expect(hasFeature(values, 'memberships')).toBe(false);
    expect(hasFeature(values, 'reports_full')).toBe(false);
    expect(hasFeature(null, 'reports_full')).toBe(true);
  });

  it('normaliza lo que envía ADMIN', () => {
    expect(normalizeEntitlement('promotions', 5)).toBe(1);
    expect(normalizeEntitlement('promotions', true)).toBe(1);
    expect(normalizeEntitlement('promotions', null)).toBe(0);
    expect(normalizeEntitlement('barbers', 3.7)).toBe(3);
    expect(normalizeEntitlement('barbers', -2)).toBe(0);
    expect(normalizeEntitlement('barbers', null)).toBeNull();
    expect(normalizeEntitlement('barbers', true)).toBeNull();
    expect(normalizeEntitlement('barbers', false)).toBe(0);
  });
});

describe('Ranking de clientes', () => {
  const t = { gold: 100, silver: 50, bronze: 10 };
  it('puntaje por visitas, gasto y antigüedad (hasta 24 meses)', () => {
    const now = Date.UTC(2030, 0, 1);
    expect(rankingScore({ visits: 2, spent: 5000, firstVisitAt: null, now })).toBe(25);
    expect(rankingScore({ visits: 0, spent: 0, firstVisitAt: new Date(now - 90 * DAY), now })).toBe(
      3,
    );
    expect(
      rankingScore({ visits: 0, spent: 0, firstVisitAt: new Date(now - 900 * DAY), now }),
    ).toBe(24);
  });
  it('niveles', () => {
    expect(tierFor(5, t)).toBe('NONE');
    expect(tierFor(10, t)).toBe('BRONZE');
    expect(tierFor(50, t)).toBe('SILVER');
    expect(tierFor(250, t)).toBe('GOLD');
  });
  it('promoción por nivel mínimo', () => {
    const promo: PromotionCandidate = {
      id: 'p',
      name: 'x',
      scope: 'BARBERSHOP',
      scopeId: 's',
      type: 'PERCENTAGE',
      value: 10,
      currency: null,
      rules: parseRules({ minTier: 'SILVER', daysOfWeek: [1] }),
    };
    const ctx = {
      barbershopId: 's',
      serviceId: 'v',
      subtotal: 1000,
      currency: 'PEN',
      dayOfWeek: 1,
    };
    expect(appliesTo(promo, { ...ctx, clientTier: 'GOLD' })).toBe(true);
    expect(appliesTo(promo, { ...ctx, clientTier: 'BRONZE' })).toBe(false);
    expect(appliesTo(promo, ctx)).toBe(false);
    expect(parseRules({ minTier: 'PLATINO' })).toEqual({});
  });
});

describe('Boletas', () => {
  afterEach(() => jest.restoreAllMocks());
  const req = {
    series: 'B001',
    number: 7,
    issuedAt: new Date('2030-01-07T15:00:00Z'),
    currency: 'PEN',
    totalAmount: 2500,
    taxAmount: taxIncluded(2500),
    customer: { docType: 'NONE' as const, docNumber: null, name: null },
    lines: [{ description: 'Corte', quantity: 1, unitAmount: 2500, totalAmount: 2500 }],
  };

  it('IGV incluido y descuento repartido', () => {
    expect(taxIncluded(2500)).toBe(381);
    expect(taxIncluded(11800)).toBe(1800);
    const lines = discounted(
      [
        { description: 'Corte', quantity: 1, unitAmount: 2500, totalAmount: 2500 },
        { description: 'Cera', quantity: 2, unitAmount: 750, totalAmount: 1500 },
      ],
      2000,
    );
    expect(lines.map((l) => l.totalAmount)).toEqual([2000, 0]);
  });

  it('simulada: emite con número', async () => {
    expect(await new FakeInvoiceProvider().issue(req)).toMatchObject({
      status: 'ISSUED',
      pdfUrl: 'https://fake.invoices/B001-00000007.pdf',
    });
  });

  it('Nubefact: envía la boleta y lee el enlace; rechazos y caídas', async () => {
    const nubefact = new NubefactInvoiceProvider();
    expect((await nubefact.issue(req, { apiUrl: null, token: null })).status).toBe('REJECTED');

    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ enlace_del_pdf: 'https://nubefact/pdf', aceptada_por_sunat: true }),
      )
      .mockResolvedValueOnce(
        Response.json({ errors: 'Serie inválida', codigo: 20 }, { status: 400 }),
      )
      .mockResolvedValueOnce(Response.json({}, { status: 502 }))
      .mockRejectedValueOnce(new TypeError('red'));
    const creds = { apiUrl: 'https://api.nubefact.com/x', token: 'tok-1234567890' };
    const ok = await nubefact.issue(req, creds);
    expect(ok).toMatchObject({ status: 'ISSUED', pdfUrl: 'https://nubefact/pdf' });
    const sent = sentBody(spy.mock.calls[0]![1]);
    expect(sent).toMatchObject({
      operacion: 'generar_comprobante',
      tipo_de_comprobante: 2,
      serie: 'B001',
      numero: 7,
      fecha_de_emision: '07-01-2030',
      total_gravada: 21.19,
      total_igv: 3.81,
      total: 25,
      cliente_tipo_de_documento: '-',
    });
    expect((spy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Token token="tok-1234567890"',
    });
    expect(await nubefact.issue(req, creds)).toMatchObject({
      status: 'REJECTED',
      error: 'Serie inválida',
    });
    await expect(nubefact.issue(req, creds)).rejects.toBeInstanceOf(InvoiceProviderError);
    await expect(nubefact.issue(req, creds)).rejects.toBeInstanceOf(InvoiceProviderError);
  });
});
