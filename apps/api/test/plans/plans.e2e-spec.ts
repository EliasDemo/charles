import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import type { BillingWebhookEvent } from '../../src/modules/billing/billing-gateway';
import {
  FAKE_BILLING_SIGNATURE_HEADER,
  FakeBillingGateway,
} from '../../src/modules/billing/fake-billing-gateway';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { SubscriptionsService } from '../../src/modules/plans/subscriptions.service';
import { AuthClient, createAuthTestApp, waitForMail } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { staffToken } from '../support/mfa';

const DAY = 86_400_000;

/** Fase 15: planes, suscripciones (pasarela simulada), límites por plan, comisión y paquetes. */
describe('Planes y suscripciones (e2e, Fase 15)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  let boss: Person;
  let fake: FakeBillingGateway;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  async function webhook(event: Exclude<BillingWebhookEvent, { kind: 'IGNORED' }>, expected = 200) {
    const { body, signature } = fake.signedWebhook(event);
    const sender = new AuthClient(app);
    return sender.http
      .post(`${API}/billing/webhooks/fake`)
      .set('X-Forwarded-For', sender.ip)
      .set('Content-Type', 'application/json')
      .set(FAKE_BILLING_SIGNATURE_HEADER, signature)
      .send(body)
      .expect(expected);
  }

  async function createPlan(body: Record<string, unknown>, values: Record<string, number | null>) {
    const res = await boss.client.post(`${API}/admin/plans`, body, boss.token).expect(201);
    await boss.client
      .put(
        `${API}/admin/plans/${res.body.id}/entitlements`,
        { values, reason: 'Plan de prueba' },
        boss.token,
      )
      .expect(200);
    return res.body.id as string;
  }

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    fake = app.get(FakeBillingGateway);
    kit = bookingKit(app, clock);
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    boss = { client, token: tokens.accessToken, userId: tokens.user.id, email };
    await prisma.userRole.create({ data: { userId: boss.userId, role: 'ADMIN' } });
    boss.token = await staffToken(app, boss);
    // Planes de esta prueba (se borran al final: son globales).
    await createPlan(
      {
        code: 'e2e_free',
        name: 'Gratis',
        audience: 'BARBERSHOP',
        priceMonthly: 0,
        trialDays: 0,
        isDefault: true,
        sortOrder: 0,
        isVisible: true,
      },
      {
        barbers: 1,
        gallery_photos: 5,
        featured_days_month: 0,
        messages_month: 10,
        crm_clients: 10,
        local_sales_month: 10,
        promotions: 0,
      },
    );
    await createPlan(
      {
        code: 'e2e_pro',
        name: 'Pro',
        audience: 'BARBERSHOP',
        priceMonthly: 5900,
        priceYearly: 59000,
        trialDays: 14,
        commissionBp: 500,
        isDefault: false,
        sortOrder: 1,
        isVisible: true,
      },
      {
        barbers: 3,
        gallery_photos: 50,
        featured_days_month: 3,
        messages_month: null,
        crm_clients: null,
        local_sales_month: null,
        promotions: 1,
        client_ranking: 1,
        verified_badge: 1,
      },
    );
  });

  afterAll(async () => {
    await prisma.billingCharge.deleteMany({ where: { subscriptionId: { not: null } } });
    await prisma.subscription.deleteMany({});
    await prisma.plan.deleteMany({ where: { code: { startsWith: 'e2e_' } } });
    await app.close();
  });

  it('ADMIN: catálogo, planes y validaciones; el público ve solo los visibles', async () => {
    const catalog = await boss.client
      .get(`${API}/admin/plans/entitlements`, boss.token)
      .expect(200);
    expect(catalog.body.map((d: { key: string }) => d.key)).toContain('barbers');
    const list = await boss.client.get(`${API}/admin/plans`, boss.token).expect(200);
    const pro = list.body.find((p: { code: string }) => p.code === 'e2e_pro');
    expect(
      pro.entitlements.find((e: { key: string }) => e.key === 'messages_month').value,
    ).toBeNull();
    expect(pro.entitlements.find((e: { key: string }) => e.key === 'memberships').value).toBe(0);

    await boss.client
      .post(
        `${API}/admin/plans`,
        {
          code: 'e2e_pro',
          name: 'Xx',
          audience: 'BARBERSHOP',
          priceMonthly: 100,
          trialDays: 0,
          isDefault: false,
          sortOrder: 0,
          isVisible: true,
        },
        boss.token,
      )
      .expect(409);
    await boss.client
      .post(
        `${API}/admin/plans`,
        {
          code: 'e2e_bad',
          name: 'Xx',
          audience: 'BARBERSHOP',
          priceMonthly: 100,
          trialDays: 0,
          isDefault: true,
          sortOrder: 0,
          isVisible: true,
        },
        boss.token,
      )
      .expect(400);
    await boss.client
      .put(
        `${API}/admin/plans/${pro.id}/entitlements`,
        { values: { nope: 1 }, reason: 'Clave inválida' },
        boss.token,
      )
      .expect(400);

    const hidden = await boss.client
      .post(
        `${API}/admin/plans`,
        {
          code: 'e2e_hidden',
          name: 'Oculto',
          audience: 'BARBERSHOP',
          priceMonthly: 100,
          trialDays: 0,
          isDefault: false,
          sortOrder: 9,
          isVisible: false,
        },
        boss.token,
      )
      .expect(201);
    const publicList = await new AuthClient(app)
      .get(`${API}/plans?audience=BARBERSHOP`)
      .expect(200);
    const codes = publicList.body.map((p: { code: string }) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['e2e_free', 'e2e_pro']));
    expect(codes).not.toContain('e2e_hidden');
    await boss.client
      .delete(`${API}/admin/plans/${hidden.body.id}`, boss.token)
      .send({ reason: 'Sin uso' })
      .expect(204);
  });

  it('plan gratis por defecto: límites, función no incluida y uso', async () => {
    const shop = await kit.shopReady();
    const plan = await shop.owner.client
      .get(`${API}/barbershops/${shop.shopId}/plan`, shop.owner.token)
      .expect(200);
    expect(plan.body.plan.code).toBe('e2e_free');
    expect(plan.body.subscription).toBeNull();
    expect(plan.body.usage.find((u: { key: string }) => u.key === 'barbers')).toMatchObject({
      limit: 1,
      used: 1,
    });

    const second = await shop.owner.client
      .post(`${API}/barbershops/${shop.shopId}/barbers`, { displayName: 'Luis' }, shop.owner.token)
      .expect(403);
    expect(second.body.code).toBe('PLAN_LIMIT_REACHED');
    expect(second.body.details[0]).toMatchObject({ key: 'barbers', limit: 1, used: 1 });

    const promo = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/promotions`,
        { name: '10 % martes', type: 'PERCENTAGE', value: 10 },
        shop.owner.token,
      )
      .expect(403);
    expect(promo.body.code).toBe('PLAN_FEATURE_NOT_INCLUDED');

    const featured = await shop.owner.client
      .post(`${API}/barbershops/${shop.shopId}/featured`, { days: 1 }, shop.owner.token)
      .expect(403);
    expect(featured.body.code).toBe('PLAN_LIMIT_REACHED');
    const badges = await new AuthClient(app)
      .get(`${API}/barbershops/${shop.shopId}/plan/badges`)
      .expect(200);
    expect(badges.body).toEqual({ verified: false });
  });

  it('contratar Pro: enlace por correo, prueba gratis, cobro, atraso, gracia y baja al gratis sin borrar', async () => {
    const shop = await kit.shopReady();
    const owner = shop.owner;
    // Solo el OWNER contrata; un plan inexistente o gratis no se contrata.
    await owner.client
      .post(`${API}/barbershops/${shop.shopId}/subscription`, { planCode: 'nada' }, owner.token)
      .expect(404);
    await owner.client
      .post(`${API}/barbershops/${shop.shopId}/subscription`, { planCode: 'e2e_free' }, owner.token)
      .expect(400);

    const sub = await owner.client
      .post(`${API}/barbershops/${shop.shopId}/subscription`, { planCode: 'e2e_pro' }, owner.token)
      .expect(201);
    expect(sub.body).toMatchObject({ status: 'PENDING', priceAmount: 5900, interval: 'MONTHLY' });
    expect(sub.body.checkoutUrl).toMatch(/^https:\/\/fake\.billing\//);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } });
    const providerId = row.providerSubscriptionId!;
    // El enlace llega por correo al dueño.
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
    await app.get(NotificationsService).deliverDue();
    const mail = await waitForMail(app, owner.email, 'notification:PLAN_UPDATE');
    expect(mail.text).toContain(sub.body.checkoutUrl);

    // El dueño autoriza: empieza la prueba gratis.
    await webhook({
      kind: 'SUBSCRIPTION',
      providerEventId: `pre:${providerId}:A`,
      providerSubscriptionId: providerId,
      reference: `sub:${sub.body.id}`,
      status: 'AUTHORIZED',
    });
    const trial = await owner.client
      .get(`${API}/barbershops/${shop.shopId}/subscription`, owner.token)
      .expect(200);
    expect(trial.body.status).toBe('TRIALING');
    expect(new Date(trial.body.trialEndsAt).getTime()).toBe(clock.current + 14 * DAY);
    // El mismo aviso otra vez no se aplica de nuevo.
    const dup = await webhook({
      kind: 'SUBSCRIPTION',
      providerEventId: `pre:${providerId}:A`,
      providerSubscriptionId: providerId,
      reference: `sub:${sub.body.id}`,
      status: 'AUTHORIZED',
    });
    expect(dup.body).toEqual({ received: true, duplicate: true });

    // Ya con Pro: segundo barbero, promoción y días destacados.
    await owner.client
      .post(`${API}/barbershops/${shop.shopId}/barbers`, { displayName: 'Luis' }, owner.token)
      .expect(201);
    await owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/promotions`,
        { name: '10 % martes', type: 'PERCENTAGE', value: 10 },
        owner.token,
      )
      .expect(201);
    const feat = await owner.client
      .post(`${API}/barbershops/${shop.shopId}/featured`, { days: 2 }, owner.token)
      .expect(201);
    expect(feat.body).toMatchObject({ daysUsed: 2, daysLimit: 3 });
    await owner.client
      .post(`${API}/barbershops/${shop.shopId}/featured`, { days: 2 }, owner.token)
      .expect(403);
    const badges = await new AuthClient(app)
      .get(`${API}/barbershops/${shop.shopId}/plan/badges`)
      .expect(200);
    expect(badges.body).toEqual({ verified: true });

    // Comisión del plan (5 %) en la cotización de una reserva.
    const booking = await kit.book(shop, lima(MONDAY, '10:00'));
    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    // Con la promoción del 10 % activa: comisión del plan (5 %) sobre S/ 22.50.
    expect(stored.commissionAmount).toBe(Math.round((2250 * 500) / 10_000));

    // Primer cobro: activa.
    await webhook({
      kind: 'SUBSCRIPTION_PAYMENT',
      providerEventId: 'ap:1:PAID',
      providerSubscriptionId: providerId,
      reference: `sub:${sub.body.id}`,
      providerPaymentId: 'pay-1',
      outcome: 'PAID',
      amount: 5900,
      currency: 'PEN',
      failureReason: null,
    });
    let state = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } });
    expect(state.status).toBe('ACTIVE');
    expect(
      await prisma.billingCharge.count({ where: { subscriptionId: sub.body.id, status: 'PAID' } }),
    ).toBe(1);

    // Cobro fallido: pago atrasado con 7 días de gracia.
    clock.current += 30 * DAY;
    await webhook({
      kind: 'SUBSCRIPTION_PAYMENT',
      providerEventId: 'ap:2:FAILED',
      providerSubscriptionId: providerId,
      reference: `sub:${sub.body.id}`,
      providerPaymentId: 'pay-2',
      outcome: 'FAILED',
      amount: 5900,
      currency: 'PEN',
      failureReason: 'cc_rejected_insufficient_amount',
    });
    state = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } });
    expect(state.status).toBe('PAST_DUE');
    expect(state.graceUntil!.getTime()).toBe(clock.current + 7 * DAY);

    // Termina la gracia: baja al plan gratis; el barbero de más queda inactivo (no se borra).
    clock.current += 8 * DAY;
    const result = await app.get(SubscriptionsService).runMaintenance();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    state = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } });
    expect(state.status).toBe('EXPIRED');
    expect(fake.amountOf(providerId)).toBe(5900);
    const summary = await owner.client
      .get(`${API}/barbershops/${shop.shopId}/plan`, owner.token)
      .expect(200);
    expect(summary.body.plan.code).toBe('e2e_free');
    expect(summary.body.suspendedBarbers).toBe(1);
    const barbers = await prisma.barber.findMany({
      where: { barbershopId: shop.shopId },
      orderBy: { createdAt: 'asc' },
    });
    expect(barbers.map((b) => b.isActive)).toEqual([true, false]);
    expect(barbers[1]!.planSuspendedAt).not.toBeNull();

    // El dueño elige cuál sigue activo (dentro del límite).
    await owner.client
      .put(
        `${API}/barbershops/${shop.shopId}/plan/active-barbers`,
        { barberIds: [barbers[0]!.id, barbers[1]!.id] },
        owner.token,
      )
      .expect(403);
    await owner.client
      .put(
        `${API}/barbershops/${shop.shopId}/plan/active-barbers`,
        { barberIds: [barbers[1]!.id] },
        owner.token,
      )
      .expect(200);
    const swapped = await prisma.barber.findMany({
      where: { barbershopId: shop.shopId },
      orderBy: { createdAt: 'asc' },
    });
    expect(swapped.map((b) => b.isActive)).toEqual([false, true]);
  });

  it('cambio de plan con reemplazo, cancelación al fin del periodo y acciones de ADMIN', async () => {
    const shop = await kit.shopReady();
    const owner = shop.owner;
    const first = await owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/subscription`,
        { planCode: 'e2e_pro', interval: 'YEARLY' },
        owner.token,
      )
      .expect(201);
    expect(first.body.priceAmount).toBe(59000);
    const providerId = (
      await prisma.subscription.findUniqueOrThrow({ where: { id: first.body.id } })
    ).providerSubscriptionId!;
    await webhook({
      kind: 'SUBSCRIPTION',
      providerEventId: `pre:${providerId}:B`,
      providerSubscriptionId: providerId,
      reference: `sub:${first.body.id}`,
      status: 'AUTHORIZED',
    });

    // Ya probó: la segunda suscripción no tiene prueba gratis; sin `replace`, 409.
    const again = await owner.client
      .post(`${API}/barbershops/${shop.shopId}/subscription`, { planCode: 'e2e_pro' }, owner.token)
      .expect(409);
    expect(again.body.code).toBe('SUBSCRIPTION_EXISTS');
    const replacement = await owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/subscription`,
        { planCode: 'e2e_pro', replace: true },
        owner.token,
      )
      .expect(201);
    const replId = (
      await prisma.subscription.findUniqueOrThrow({ where: { id: replacement.body.id } })
    ).providerSubscriptionId!;
    await webhook({
      kind: 'SUBSCRIPTION',
      providerEventId: `pre:${replId}:C`,
      providerSubscriptionId: replId,
      reference: `sub:${replacement.body.id}`,
      status: 'AUTHORIZED',
    });
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: first.body.id } })).status,
    ).toBe('EXPIRED');
    const now = await prisma.subscription.findUniqueOrThrow({ where: { id: replacement.body.id } });
    expect(now.status).toBe('ACTIVE');
    expect(now.trialEndsAt).toBeNull();

    // Cancelar: sigue hasta el fin del periodo.
    const canceled = await owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/subscription/cancel`,
        { reason: 'Muy caro' },
        owner.token,
      )
      .expect(200);
    expect(canceled.body).toMatchObject({ status: 'CANCELED', cancelAtPeriodEnd: true });
    expect(
      (await owner.client.get(`${API}/barbershops/${shop.shopId}/plan`, owner.token).expect(200))
        .body.plan.code,
    ).toBe('e2e_pro');

    // ADMIN: resumen, días de cortesía y cancelación inmediata.
    const list = await boss.client
      .get(`${API}/admin/subscriptions?barbershopId=${shop.shopId}`, boss.token)
      .expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    const summary = await boss.client
      .get(`${API}/admin/subscriptions/summary`, boss.token)
      .expect(200);
    expect(summary.body).toEqual(
      expect.objectContaining({ mrr: expect.any(Number), byPlan: expect.any(Array) }),
    );
    const extended = await boss.client
      .post(
        `${API}/admin/subscriptions/${replacement.body.id}/extend`,
        { days: 5, reason: 'Compensación' },
        boss.token,
      )
      .expect(200);
    expect(new Date(extended.body.currentPeriodEnd).getTime()).toBe(
      now.currentPeriodEnd!.getTime() + 5 * DAY,
    );
    const ended = await boss.client
      .post(
        `${API}/admin/subscriptions/${replacement.body.id}/cancel`,
        { reason: 'Fraude comprobado' },
        boss.token,
      )
      .expect(200);
    expect(ended.body.status).toBe('EXPIRED');
    expect(
      (await owner.client.get(`${API}/barbershops/${shop.shopId}/plan`, owner.token).expect(200))
        .body.plan.code,
    ).toBe('e2e_free');
  });

  it('precio nuevo: las vigentes lo pagan desde la renovación, con aviso', async () => {
    const shop = await kit.shopReady();
    const sub = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/subscription`,
        { planCode: 'e2e_pro' },
        shop.owner.token,
      )
      .expect(201);
    const providerId = (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } }))
      .providerSubscriptionId!;
    await webhook({
      kind: 'SUBSCRIPTION',
      providerEventId: `pre:${providerId}:D`,
      providerSubscriptionId: providerId,
      reference: `sub:${sub.body.id}`,
      status: 'AUTHORIZED',
    });
    const pro = (await prisma.plan.findUniqueOrThrow({ where: { code: 'e2e_pro' } })).id;
    await boss.client
      .patch(
        `${API}/admin/plans/${pro}`,
        { priceMonthly: 6900, reason: 'Ajuste anual de precios' },
        boss.token,
      )
      .expect(200);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } });
    expect(row.priceAmount).toBe(5900);
    expect(row.nextPriceAmount).toBe(6900);
    expect(row.nextPriceFrom!.getTime()).toBeGreaterThanOrEqual(clock.current + 30 * DAY);

    clock.current = row.nextPriceFrom!.getTime() + 1;
    const run = await app.get(SubscriptionsService).runMaintenance();
    expect(run.repriced).toBeGreaterThanOrEqual(1);
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } })).priceAmount,
    ).toBe(6900);
    expect(fake.amountOf(providerId)).toBe(6900);
    await boss.client
      .patch(
        `${API}/admin/plans/${pro}`,
        { priceMonthly: 5900, reason: 'Vuelve el precio' },
        boss.token,
      )
      .expect(200);
  });

  it('avisos: firma inválida 401, pasarela caída 503 y sincronización al volver del pago', async () => {
    const sender = new AuthClient(app);
    await sender.http
      .post(`${API}/billing/webhooks/fake`)
      .set('Content-Type', 'application/json')
      .set(FAKE_BILLING_SIGNATURE_HEADER, 'ab'.repeat(32))
      .send(JSON.stringify({ kind: 'SUBSCRIPTION' }))
      .expect(401);
    await sender.http.post(`${API}/billing/webhooks/otro`).send('{}').expect(404);

    const shop = await kit.shopReady();
    fake.unavailable = true;
    const down = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/subscription`,
        { planCode: 'e2e_pro' },
        shop.owner.token,
      )
      .expect(503);
    expect(down.body.code).toBe('BILLING_UNAVAILABLE');
    fake.unavailable = false;

    const sub = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/subscription`,
        { planCode: 'e2e_pro' },
        shop.owner.token,
      )
      .expect(201);
    const providerId = (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.body.id } }))
      .providerSubscriptionId!;
    fake.setSubscriptionStatus(providerId, 'AUTHORIZED');
    const synced = await shop.owner.client
      .post(`${API}/barbershops/${shop.shopId}/subscription/sync`, {}, shop.owner.token)
      .expect(200);
    expect(synced.body.status).toBe('TRIALING');
  });

  it('paquete de auspiciador: enlace por correo, pago, campaña activa con topes', async () => {
    const pkg = await boss.client
      .post(
        `${API}/admin/sponsor-packages`,
        {
          code: `e2e_${randomUUID().slice(0, 8)}`,
          name: 'Crecimiento',
          priceAmount: 150000,
          impressionsLimit: 2,
          placementsLimit: 1,
          durationDays: 30,
          sortOrder: 0,
        },
        boss.token,
      )
      .expect(201);
    const sponsor = await boss.client
      .post(`${API}/admin/sponsors`, { name: 'Marca E2E' }, boss.token)
      .expect(201);
    const purchase = await boss.client
      .post(
        `${API}/admin/sponsors/${sponsor.body.id}/package-purchases`,
        {
          packageId: pkg.body.id,
          campaignName: 'Lanzamiento',
          audience: 'ALL',
          payerEmail: 'marca@example.com',
        },
        boss.token,
      )
      .expect(201);
    expect(purchase.body).toMatchObject({ status: 'PENDING' });
    await waitForMail(app, 'marca@example.com', 'sponsor-package-checkout');

    // Monto distinto: no se activa.
    await webhook({
      kind: 'PAYMENT',
      providerEventId: 'pay:x:1',
      providerSubscriptionId: null,
      reference: `spk:${purchase.body.id}`,
      providerPaymentId: 'spk-wrong',
      outcome: 'PAID',
      amount: 100,
      currency: 'PEN',
      failureReason: null,
    });
    expect(
      (await prisma.sponsorPackagePurchase.findUniqueOrThrow({ where: { id: purchase.body.id } }))
        .status,
    ).toBe('PENDING');
    await webhook({
      kind: 'PAYMENT',
      providerEventId: 'pay:x:2',
      providerSubscriptionId: null,
      reference: `spk:${purchase.body.id}`,
      providerPaymentId: 'spk-ok',
      outcome: 'PAID',
      amount: 150000,
      currency: 'PEN',
      failureReason: null,
    });
    const paid = await boss.client
      .get(`${API}/admin/sponsors/${sponsor.body.id}/package-purchases`, boss.token)
      .expect(200);
    expect(paid.body[0]).toMatchObject({ status: 'PAID', checkoutUrl: null });
    const campaign = await prisma.sponsorCampaign.findUniqueOrThrow({
      where: { id: paid.body[0].campaignId },
    });
    expect(campaign).toMatchObject({ status: 'ACTIVE', impressionsLimit: 2 });

    // Tope de anuncios del paquete.
    const placement = await boss.client
      .post(
        `${API}/admin/campaigns/${campaign.id}/placements`,
        { slotKey: 'home_banner', title: 'Anuncio' },
        boss.token,
      )
      .expect(201);
    await boss.client
      .post(
        `${API}/admin/campaigns/${campaign.id}/placements`,
        { slotKey: 'search_top', title: 'Otro' },
        boss.token,
      )
      .expect(403);

    // Tope de impresiones: al llegar, la campaña termina.
    const placementId = placement.body.placements[0].id as string;
    for (const viewerKey of [randomUUID(), randomUUID()]) {
      await new AuthClient(app)
        .post(`${API}/placements/${placementId}/events`, { type: 'IMPRESSION', viewerKey })
        .expect(204);
    }
    expect(
      (await prisma.sponsorCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).status,
    ).toBe('ENDED');

    // Una compra sin pagar se anula.
    const other = await boss.client
      .post(
        `${API}/admin/sponsors/${sponsor.body.id}/package-purchases`,
        {
          packageId: pkg.body.id,
          campaignName: 'Segunda',
          audience: 'ALL',
          payerEmail: 'marca@example.com',
        },
        boss.token,
      )
      .expect(201);
    const canceled = await boss.client
      .post(`${API}/admin/package-purchases/${other.body.id}/cancel`, {}, boss.token)
      .expect(200);
    expect(canceled.body.status).toBe('CANCELED');
    await boss.client
      .post(`${API}/admin/package-purchases/${other.body.id}/cancel`, {}, boss.token)
      .expect(409);
  });
});
