import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { FakeGateway } from '../../src/modules/payments/fake-gateway';
import { SubscriptionsService } from '../../src/modules/plans/subscriptions.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import {
  API,
  bookingKit,
  type BookingKit,
  HOUR,
  lima,
  MONDAY,
  type Person,
} from '../support/bookings';
import { staffToken } from '../support/mfa';

const DAY = 86_400_000;
const MIRAFLORES = '150122';

/**
 * Pedidos de la app (ubicación, empleos completos, ofertas directas, "lista para reservar") y
 * negocio (reportes por mes, mapa de horas, mercado, Marketplace, saldo y plan pagado con saldo).
 */
describe('Ubicación, empleos, reportes y saldo (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  let boss: Person;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    kit = bookingKit(app, clock);
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    boss = { client, token: tokens.accessToken, userId: tokens.user.id, email };
    await prisma.userRole.create({ data: { userId: boss.userId, role: 'ADMIN' } });
    boss.token = await staffToken(app, boss);
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
  });
  afterAll(async () => {
    const subs = { subscription: { plan: { code: 'e2e_bal' } } };
    await prisma.billingCharge.deleteMany({ where: subs });
    await prisma.balanceMovement.deleteMany({ where: subs });
    await prisma.subscription.deleteMany({ where: { plan: { code: 'e2e_bal' } } });
    await prisma.plan.deleteMany({ where: { code: 'e2e_bal' } });
    await app.close();
  });

  it('ubicaciones: departamentos, provincias, distritos y búsqueda por código', async () => {
    const http = new AuthClient(app);
    const deps = await http.get(`${API}/locations/departments`).expect(200);
    expect(deps.body).toContain('Puno');
    const provinces = await http.get(`${API}/locations/provinces?department=Puno`).expect(200);
    expect(provinces.body.map((x: { province: string }) => x.province)).toContain('San Roman');
    const districts = await http
      .get(`${API}/locations/districts?province=San%20Roman&q=julia`)
      .expect(200);
    expect(districts.body[0]).toMatchObject({
      ubigeo: '211101',
      district: 'Juliaca',
      province: 'San Roman',
    });
    const one = await http.get(`${API}/locations/districts/${MIRAFLORES}`).expect(200);
    expect(one.body).toMatchObject({ district: 'Miraflores', department: 'Lima' });
    await http.get(`${API}/locations/districts/999999`).expect(404);
  });

  it('barbería y perfil con distrito; ranking por provincia y cercanía', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const pub = await o.client.get(`${API}/barbershops/${shop.shopId}`, o.token).expect(200);
    // Sin ubigeo: el distrito más cercano a sus coordenadas (Lima).
    expect(pub.body.location).toMatchObject({ department: 'Lima' });
    await o.client
      .patch(`${API}/barbershops/${shop.shopId}`, { ubigeo: '000000' }, o.token)
      .expect(400);
    const updated = await o.client
      .patch(`${API}/barbershops/${shop.shopId}`, { ubigeo: MIRAFLORES }, o.token)
      .expect(200);
    expect(updated.body.location).toMatchObject({ ubigeo: MIRAFLORES, district: 'Miraflores' });

    const barber = await kit.verified();
    const profile = await barber.client
      .put(
        `${API}/me/barber-profile`,
        { displayName: 'Rocío', ubigeo: '211101', availableForWork: true },
        barber.token,
      )
      .expect(200);
    expect(profile.body.location).toMatchObject({ district: 'Juliaca', province: 'San Roman' });

    const byProvince = await barber.client
      .get(`${API}/barbers/ranking?province=Lima`, barber.token)
      .expect(200);
    expect(Array.isArray(byProvince.body.items ?? byProvince.body)).toBe(true);
    const near = await barber.client
      .get(`${API}/barbers/ranking?lat=-15.49&lng=-70.13&radiusKm=30&sort=distance`, barber.token)
      .expect(200);
    const items = (near.body.items ?? near.body) as { distanceKm: number | null }[];
    for (const item of items) expect(item.distanceKm === null || item.distanceKm <= 30).toBe(true);
  });

  it('empleos con condiciones completas, filtros, ofertas directas y "lista para reservar"', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const base = `${API}/barbershops/${shop.shopId}`;
    await o.client.patch(base, { ubigeo: MIRAFLORES }, o.token).expect(200);

    const ready = await o.client.get(`${base}/readiness`, o.token).expect(200);
    expect(ready.body).toHaveProperty('ready');
    expect(ready.body.bookableBarbers).toBe(1);

    await o.client
      .post(
        `${base}/jobs`,
        {
          title: 'Barbero',
          description: 'Turno tarde',
          employmentType: 'FULL_TIME',
          payMin: 200_000,
          payMax: 100_000,
        },
        o.token,
      )
      .expect(400);
    const posting = await o.client
      .post(
        `${base}/jobs`,
        {
          title: 'Barbero de fades',
          description: 'Buscamos barbero con experiencia.',
          employmentType: 'FULL_TIME',
          payMin: 120_000,
          payMax: 180_000,
          payType: 'MIXED',
          payPeriod: 'MONTH',
          negotiable: true,
          requirements: ['2 años de experiencia', 'Herramientas propias'],
          selectionProcess: 'TRIAL',
          schedule: 'Lunes a sábado',
        },
        o.token,
      )
      .expect(201);
    expect(posting.body).toMatchObject({
      payMin: 120_000,
      payType: 'MIXED',
      negotiable: true,
      selectionProcess: 'TRIAL',
      requirements: ['2 años de experiencia', 'Herramientas propias'],
      location: { ubigeo: MIRAFLORES },
    });

    const barber = await kit.verified();
    const profile = await barber.client
      .put(
        `${API}/me/barber-profile`,
        { displayName: 'Ana Prueba', ubigeo: MIRAFLORES, availableForWork: true },
        barber.token,
      )
      .expect(200);
    const list = await barber.client
      .get(`${API}/jobs?ubigeo=${MIRAFLORES}`, barber.token)
      .expect(200);
    const ids = (list.body.items ?? list.body).map((j: { id: string }) => j.id);
    expect(ids).toContain(posting.body.id);
    const nearby = await barber.client
      .get(`${API}/jobs?lat=-12.12&lng=-77.03&radiusKm=5&sort=distance`, barber.token)
      .expect(200);
    const near = (nearby.body.items ?? nearby.body).find(
      (j: { id: string }) => j.id === posting.body.id,
    );
    expect(near.distanceKm).toBeLessThanOrEqual(5);

    // Oferta directa: pendiente única, el barbero la acepta y queda en el equipo.
    const offer = await o.client
      .post(
        `${base}/job-offers`,
        {
          barberProfileId: profile.body.id,
          title: 'Puesto fijo',
          employmentType: 'FULL_TIME',
          payMin: 150_000,
        },
        o.token,
      )
      .expect(201);
    expect(offer.body.status).toBe('PENDING');
    await o.client
      .post(
        `${base}/job-offers`,
        { barberProfileId: profile.body.id, title: 'Otra', employmentType: 'FULL_TIME' },
        o.token,
      )
      .expect(409);
    const mine = await barber.client.get(`${API}/me/job-offers`, barber.token).expect(200);
    expect(mine.body.map((x: { id: string }) => x.id)).toContain(offer.body.id);
    const intruder = await kit.verified();
    await intruder.client
      .post(`${API}/me/job-offers/${offer.body.id}/accept`, {}, intruder.token)
      .expect(404);
    const accepted = await barber.client
      .post(`${API}/me/job-offers/${offer.body.id}/accept`, {}, barber.token)
      .expect(200);
    expect(accepted.body.status).toBe('ACCEPTED');
    const team = await prisma.barber.count({
      where: { barbershopId: shop.shopId, userId: barber.userId },
    });
    expect(team).toBe(1);
    await barber.client
      .post(`${API}/me/job-offers/${offer.body.id}/reject`, {}, barber.token)
      .expect(409);

    // Otra oferta rechazada y otra retirada.
    const second = await kit.verified();
    const p2 = await second.client
      .put(`${API}/me/barber-profile`, { displayName: 'Luis Prueba' }, second.token)
      .expect(200);
    const o2 = await o.client
      .post(
        `${base}/job-offers`,
        { barberProfileId: p2.body.id, title: 'Fines de semana', employmentType: 'WEEKENDS' },
        o.token,
      )
      .expect(201);
    const rejected = await second.client
      .post(`${API}/me/job-offers/${o2.body.id}/reject`, { note: 'Gracias' }, second.token)
      .expect(200);
    expect(rejected.body.status).toBe('REJECTED');
    const o3 = await o.client
      .post(
        `${base}/job-offers`,
        { barberProfileId: p2.body.id, title: 'Otra vez', employmentType: 'PART_TIME' },
        o.token,
      )
      .expect(201);
    const withdrawn = await o.client
      .post(`${base}/job-offers/${o3.body.id}/withdraw`, {}, o.token)
      .expect(200);
    expect(withdrawn.body.status).toBe('WITHDRAWN');
    const shopOffers = await o.client.get(`${base}/job-offers`, o.token).expect(200);
    expect(shopOffers.body).toHaveLength(3);
  });

  it('reportes por mes, mapa de horas y mercado de la zona', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const base = `${API}/barbershops/${shop.shopId}`;
    const client = await kit.verified();
    await kit.attended(shop, lima(MONDAY, '10:00'), client);
    clock.current = lima(MONDAY, '08:00') + 7 * DAY;
    await kit.attended(shop, lima(MONDAY, '11:00') + 7 * DAY, client);
    clock.current = lima(MONDAY, '20:00') + 7 * DAY;

    const monthly = await o.client.get(`${base}/reports/monthly?months=3`, o.token).expect(200);
    expect(monthly.body.months).toHaveLength(3);
    const last = monthly.body.months[2];
    expect(last.count).toBeGreaterThanOrEqual(2);
    expect(last.appAmount).toBe(5000);
    expect(last.newClients + last.returningClients).toBe(1);
    expect(monthly.body.bestMonth).toBe(last.month);

    const heat = await o.client.get(`${base}/reports/heatmap?days=30`, o.token).expect(200);
    expect(heat.body.busiestWeekday).toBe(1);
    expect(heat.body.cells.reduce((s: number, c: { count: number }) => s + c.count, 0)).toBe(2);
    expect(heat.body.quietSlots.length).toBeGreaterThan(0);

    const other = await kit.shopReady();
    void other;
    const market = await o.client.get(`${base}/reports/market?radiusKm=5`, o.token).expect(200);
    expect(market.body.competitors).toBeGreaterThanOrEqual(1);
    expect(market.body.myHaircutPrice).toBe(2500);
    await o.client.get(`${base}/reports/monthly?months=99`, o.token).expect(400);
    const stranger = await kit.verified();
    await stranger.client.get(`${base}/reports/monthly`, stranger.token).expect(404);
  });

  it('Marketplace: vincular la cuenta, cobro directo con comisión, saldo y estado de cuenta', async () => {
    const shop = await kit.shopReady();
    const o = shop.owner;
    const base = `${API}/barbershops/${shop.shopId}`;
    expect((await o.client.get(`${base}/seller-account`, o.token).expect(200)).body.status).toBe(
      'NOT_CONNECTED',
    );

    // Sin cuenta: cobra Charles y queda como saldo al atender.
    const first = await kit.attended(shop, lima(MONDAY, '10:00'));
    const p1 = await prisma.payment.findUniqueOrThrow({ where: { id: first.paymentId } });
    expect(p1.payee).toBe('PLATFORM');
    const balance1 = await o.client.get(`${base}/balance`, o.token).expect(200);
    const booking1 = await prisma.booking.findUniqueOrThrow({ where: { id: first.id } });
    expect(balance1.body).toMatchObject({
      available: p1.amount - booking1.commissionAmount,
      pending: 0,
      sellerConnected: false,
    });

    // Vincula (OAuth simulado): el enlace lleva directo al regreso con el código.
    const connect = await o.client.post(`${base}/seller-account/connect`, {}, o.token).expect(200);
    const url = new URL(connect.body.authorizationUrl);
    const http = new AuthClient(app);
    await http.http
      .get(`${url.pathname}?code=mal&state=${url.searchParams.get('state')}`)
      .expect(400);
    await http.http.get(`${url.pathname}${url.search}`).expect(200);
    const status = await o.client.get(`${base}/seller-account`, o.token).expect(200);
    expect(status.body).toMatchObject({ status: 'CONNECTED', provider: 'FAKE' });
    const stored = await prisma.sellerAccount.findUniqueOrThrow({
      where: { barbershopId: shop.shopId },
    });
    expect(stored.accessTokenEnc).not.toContain('FAKE-SELLER');

    clock.current = lima(MONDAY, '08:00') + DAY;
    const second = await kit.confirmed(shop, lima(MONDAY, '11:00') + DAY);
    const p2 = await prisma.payment.findUniqueOrThrow({ where: { id: second.paymentId } });
    const booking2 = await prisma.booking.findUniqueOrThrow({ where: { id: second.id } });
    expect(p2).toMatchObject({ payee: 'SELLER', marketplaceFee: booking2.commissionAmount });
    expect(app.get(FakeGateway).sellerOf.get(second.paymentId)).toMatchObject({
      marketplaceFee: booking2.commissionAmount,
      providerUserId: stored.providerUserId,
    });

    const statement = await o.client
      .get(
        `${base}/statement?from=${new Date(lima(MONDAY, '00:00')).toISOString()}&to=${new Date(clock.current + HOUR).toISOString()}`,
        o.token,
      )
      .expect(200);
    const kinds = statement.body.lines.map((l: { kind: string }) => l.kind).sort();
    expect(kinds).toEqual(['BOOKING', 'BOOKING_DIRECT']);
    expect(statement.body.balance.paidDirect).toBe(p2.amount - booking2.commissionAmount);
    expect(statement.body.commission).toBe(booking1.commissionAmount + booking2.commissionAmount);

    // El MANAGER no vincula ni desvincula; el dueño sí.
    await o.client.delete(`${base}/seller-account`, o.token).expect(204);
    expect((await o.client.get(`${base}/seller-account`, o.token).expect(200)).body.status).toBe(
      'REVOKED',
    );

    // ADMIN: lista de saldos, transferencia que no puede superar el saldo, ajuste.
    const available = balance1.body.available as number;
    const list = await boss.client.get(`${API}/admin/balances`, boss.token).expect(200);
    expect(
      list.body.find((b: { barbershopId: string }) => b.barbershopId === shop.shopId).available,
    ).toBe(available);
    const tooMuch = await boss.client
      .post(
        `${API}/admin/balances/${shop.shopId}/movements`,
        { type: 'PAYOUT', amount: available + 1 },
        boss.token,
      )
      .expect(409);
    expect(tooMuch.body.code).toBe('INSUFFICIENT_BALANCE');
    await boss.client
      .post(
        `${API}/admin/balances/${shop.shopId}/movements`,
        { type: 'PAYOUT', amount: 1000, reference: 'OP-1' },
        boss.token,
      )
      .expect(201);
    await boss.client
      .post(
        `${API}/admin/balances/${shop.shopId}/movements`,
        { type: 'ADJUSTMENT', amount: 300, note: 'Bono' },
        boss.token,
      )
      .expect(201);
    expect((await o.client.get(`${base}/balance`, o.token).expect(200)).body.available).toBe(
      available - 700,
    );
    await o.client.get(`${API}/admin/balances`, o.token).expect(403);
  });

  it('plan pagado con el saldo a favor: al instante, renovación automática y vencido sin saldo', async () => {
    await prisma.plan.create({
      data: {
        code: 'e2e_bal',
        name: 'Pro saldo',
        audience: 'BARBERSHOP',
        priceMonthly: 3000,
        trialDays: 14,
        isVisible: true,
      },
    });
    const shop = await kit.shopReady();
    const o = shop.owner;
    const base = `${API}/barbershops/${shop.shopId}`;
    const short = await o.client
      .post(`${base}/subscription`, { planCode: 'e2e_bal', paymentMethod: 'BALANCE' }, o.token)
      .expect(409);
    expect(short.body.code).toBe('INSUFFICIENT_BALANCE');

    await boss.client
      .post(
        `${API}/admin/balances/${shop.shopId}/movements`,
        { type: 'ADJUSTMENT', amount: 7000, note: 'Saldo inicial' },
        boss.token,
      )
      .expect(201);
    const sub = await o.client
      .post(`${base}/subscription`, { planCode: 'e2e_bal', paymentMethod: 'BALANCE' }, o.token)
      .expect(201);
    expect(sub.body.status).toBe('ACTIVE');
    expect((await o.client.get(`${base}/balance`, o.token).expect(200)).body.available).toBe(4000);
    const charge = await prisma.billingCharge.findFirstOrThrow({
      where: { subscriptionId: sub.body.id },
    });
    expect(charge).toMatchObject({ provider: 'BALANCE', status: 'PAID', amount: 3000 });

    // Adelantar el periodo siguiente con saldo.
    const before = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } });
    await o.client.post(`${base}/subscription/pay-with-balance`, {}, o.token).expect(200);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } });
    expect(after.currentPeriodEnd!.getTime()).toBeGreaterThan(before.currentPeriodEnd!.getTime());
    expect((await o.client.get(`${base}/balance`, o.token).expect(200)).body.available).toBe(1000);
    const poor = await o.client
      .post(`${base}/subscription/pay-with-balance`, {}, o.token)
      .expect(409);
    expect(poor.body.code).toBe('INSUFFICIENT_BALANCE');

    // Vence el periodo sin saldo suficiente: PAST_DUE; con saldo nuevo se recupera.
    clock.current = after.currentPeriodEnd!.getTime() + HOUR;
    await app.get(SubscriptionsService).runMaintenance();
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } })).status,
    ).toBe('PAST_DUE');
    await boss.client
      .post(
        `${API}/admin/balances/${shop.shopId}/movements`,
        { type: 'ADJUSTMENT', amount: 5000 },
        boss.token,
      )
      .expect(201);
    const recovered = await o.client
      .post(`${base}/subscription/pay-with-balance`, {}, o.token)
      .expect(200);
    expect(recovered.body.status).toBe('ACTIVE');
    clock.current = lima(MONDAY, '08:00');
  });
});
