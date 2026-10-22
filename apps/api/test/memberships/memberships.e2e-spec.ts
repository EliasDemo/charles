import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import type { BillingWebhookEvent } from '../../src/modules/billing/billing-gateway';
import {
  FAKE_BILLING_SIGNATURE_HEADER,
  FakeBillingGateway,
} from '../../src/modules/billing/fake-billing-gateway';
import { MembershipsService } from '../../src/modules/memberships/memberships.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import {
  API,
  bookingKit,
  type BookingKit,
  type KitShop,
  lima,
  MONDAY,
  type Person,
} from '../support/bookings';

const DAY = 86_400_000;

/** Fase 16: membresías con créditos, pago de reservas y ventas con crédito. */
describe('Membresías (e2e, Fase 16)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  let fake: FakeBillingGateway;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  async function webhook(event: Exclude<BillingWebhookEvent, { kind: 'IGNORED' }>) {
    const { body, signature } = fake.signedWebhook(event);
    const sender = new AuthClient(app);
    return sender.http
      .post(`${API}/billing/webhooks/fake`)
      .set('Content-Type', 'application/json')
      .set(FAKE_BILLING_SIGNATURE_HEADER, signature)
      .send(body)
      .expect(200);
  }

  /** Barbería con una membresía de 2 créditos y un cliente con la membresía pagada. */
  async function memberWithCredits(): Promise<{
    shop: KitShop;
    person: Person;
    membershipId: string;
    providerId: string;
  }> {
    const shop = await kit.shopReady();
    const plan = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/membership-plans`,
        {
          name: 'Corte mensual',
          priceAmount: 4500,
          creditsPerPeriod: 2,
          serviceIds: [shop.serviceId],
        },
        shop.owner.token,
      )
      .expect(201);
    const person = await kit.verified();
    const membership = await person.client
      .post(`${API}/membership-plans/${plan.body.id}/subscribe`, {}, person.token)
      .expect(201);
    expect(membership.body).toMatchObject({ status: 'PENDING', credits: 0 });
    expect(membership.body.checkoutUrl).toMatch(/^https:\/\/fake\.billing\//);
    const providerId = (
      await prisma.membership.findUniqueOrThrow({ where: { id: membership.body.id } })
    ).providerSubscriptionId!;
    await webhook({
      kind: 'SUBSCRIPTION',
      providerEventId: `pre:${providerId}:A`,
      providerSubscriptionId: providerId,
      reference: `mem:${membership.body.id}`,
      status: 'AUTHORIZED',
    });
    await webhook({
      kind: 'SUBSCRIPTION_PAYMENT',
      providerEventId: `ap:${providerId}:1`,
      providerSubscriptionId: providerId,
      reference: `mem:${membership.body.id}`,
      providerPaymentId: `m-${randomUUID()}`,
      outcome: 'PAID',
      amount: 4500,
      currency: 'PEN',
      failureReason: null,
    });
    return { shop, person, membershipId: membership.body.id, providerId };
  }

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    fake = app.get(FakeBillingGateway);
    kit = bookingKit(app, clock);
  });
  afterAll(() => app.close());

  it('la barbería ofrece membresías; el cliente paga y recibe créditos', async () => {
    const { shop, person, membershipId } = await memberWithCredits();
    const mine = await person.client.get(`${API}/users/me/memberships`, person.token).expect(200);
    expect(mine.body[0]).toMatchObject({
      id: membershipId,
      status: 'ACTIVE',
      credits: 2,
      checkoutUrl: null,
    });
    expect(mine.body[0].plan.services[0].id).toBe(shop.serviceId);

    const publicPlans = await new AuthClient(app)
      .get(`${API}/barbershops/${shop.shopId}/membership-plans`)
      .expect(200);
    expect(publicPlans.body).toHaveLength(1);
    const managed = await shop.owner.client
      .get(`${API}/barbershops/${shop.shopId}/membership-plans/manage`, shop.owner.token)
      .expect(200);
    expect(managed.body[0].activeMembers).toBe(1);
    const members = await shop.owner.client
      .get(`${API}/barbershops/${shop.shopId}/membership-members`, shop.owner.token)
      .expect(200);
    expect(members.body[0]).toMatchObject({ planName: 'Corte mensual', credits: 2 });

    // Ya la tiene: 409. Dejar de venderla no afecta a la vigente.
    await person.client
      .post(`${API}/membership-plans/${managed.body[0].id}/subscribe`, {}, person.token)
      .expect(409);
    await shop.owner.client
      .patch(
        `${API}/barbershops/${shop.shopId}/membership-plans/${managed.body[0].id}`,
        { isActive: false },
        shop.owner.token,
      )
      .expect(200);
    expect(
      (
        await new AuthClient(app)
          .get(`${API}/barbershops/${shop.shopId}/membership-plans`)
          .expect(200)
      ).body,
    ).toEqual([]);
  });

  it('reserva pagada con crédito; al cancelarla con devolución vuelve el crédito', async () => {
    const { shop, person, membershipId } = await memberWithCredits();
    const booking = await kit.book(shop, lima('2030-01-10', '10:00'), person);
    const paid = await person.client
      .post(`${API}/bookings/${booking.id}/pay-with-membership`, { membershipId }, person.token)
      .expect(200);
    expect(paid.body).toEqual({ status: 'CONFIRMED' });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'CONFIRMED',
    );
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(payment).toMatchObject({ status: 'SUCCEEDED', method: 'MEMBERSHIP_CREDIT' });
    expect(await app.get(MembershipsService).balance(membershipId)).toBe(1);
    // Ya no está pendiente: 409.
    await person.client
      .post(`${API}/bookings/${booking.id}/pay-with-membership`, { membershipId }, person.token)
      .expect(409);

    await person.client.post(`${API}/bookings/${booking.id}/cancel`, {}, person.token).expect(200);
    expect(await app.get(MembershipsService).balance(membershipId)).toBe(2);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      'REFUNDED',
    );
  });

  it('venta en el local con crédito; sin créditos o con otro servicio, 409; anular la devuelve', async () => {
    const { shop, person, membershipId } = await memberWithCredits();
    const o = shop.owner;
    const username = (await prisma.user.findUniqueOrThrow({ where: { id: person.userId } }))
      .username;
    const client = await o.client
      .post(`${API}/barbershops/${shop.shopId}/clients`, { username }, o.token)
      .expect(201);
    const credit = (lines: unknown[]) =>
      o.client
        .post(
          `${API}/barbershops/${shop.shopId}/sales`,
          { shopClientId: client.body.id, lines, paymentMethod: 'MEMBERSHIP_CREDIT', membershipId },
          o.token,
        )
        .set('Idempotency-Key', randomUUID());

    const first = await credit([{ serviceId: shop.serviceId }]).expect(201);
    await credit([{ serviceId: shop.serviceId }]).expect(201);
    const none = await credit([{ serviceId: shop.serviceId }]).expect(409);
    expect(none.body.code).toBe('NO_MEMBERSHIP_CREDITS');
    const other = await o.client
      .post(
        `${API}/barbershops/${shop.shopId}/services`,
        { name: 'Barba', priceAmount: 1500, durationMinutes: 20, categoryKey: 'beard' },
        o.token,
      )
      .expect(201);
    const notCovered = await credit([{ serviceId: other.body.id }]).expect(409);
    expect(notCovered.body.code).toBe('MEMBERSHIP_NOT_APPLICABLE');

    await o.client
      .post(
        `${API}/barbershops/${shop.shopId}/sales/${first.body.id}/void`,
        { reason: 'Se equivocó' },
        o.token,
      )
      .expect(200);
    expect(await app.get(MembershipsService).balance(membershipId)).toBe(1);
    // Con crédito no hay boleta (ya se cobró la membresía).
    await o.client
      .post(
        `${API}/barbershops/${shop.shopId}/sales`,
        {
          shopClientId: client.body.id,
          lines: [{ serviceId: shop.serviceId }],
          paymentMethod: 'MEMBERSHIP_CREDIT',
          membershipId,
          issueInvoice: true,
        },
        o.token,
      )
      .set('Idempotency-Key', randomUUID())
      .expect(400);
  });

  it('cobro fallido, cancelación y vencimiento; los créditos duran un mes más', async () => {
    const { person, membershipId, providerId } = await memberWithCredits();
    const lot = await prisma.membershipCreditLot.findFirstOrThrow({ where: { membershipId } });
    const period = await prisma.membership.findUniqueOrThrow({ where: { id: membershipId } });
    // Acumulación de un mes: el lote vence al final del periodo siguiente.
    expect(lot.expiresAt.getTime()).toBeGreaterThan(period.currentPeriodEnd!.getTime() + 27 * DAY);

    await webhook({
      kind: 'SUBSCRIPTION_PAYMENT',
      providerEventId: `ap:${providerId}:2`,
      providerSubscriptionId: providerId,
      reference: `mem:${membershipId}`,
      providerPaymentId: `m-${randomUUID()}`,
      outcome: 'FAILED',
      amount: 4500,
      currency: 'PEN',
      failureReason: 'rechazada',
    });
    expect(
      (await prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })).status,
    ).toBe('PAST_DUE');

    const canceled = await person.client
      .post(`${API}/users/me/memberships/${membershipId}/cancel`, {}, person.token)
      .expect(200);
    expect(canceled.body).toMatchObject({
      status: 'CANCELED',
      cancelAtPeriodEnd: true,
      credits: 2,
    });
    expect(fake.amountOf(providerId)).toBe(4500);

    clock.current = period.currentPeriodEnd!.getTime() + DAY;
    await app.get(MembershipsService).runMaintenance();
    expect(
      (await prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })).status,
    ).toBe('EXPIRED');
    expect(
      (await person.client.get(`${API}/users/me/memberships`, person.token).expect(200)).body,
    ).toEqual([]);
    clock.current = lima(MONDAY, '08:00');
  });

  it('sincronizar al volver del pago y pasarela caída', async () => {
    const shop = await kit.shopReady();
    const plan = await shop.owner.client
      .post(
        `${API}/barbershops/${shop.shopId}/membership-plans`,
        { name: 'Ilimitado', priceAmount: 9000, creditsPerPeriod: 4 },
        shop.owner.token,
      )
      .expect(201);
    const person = await kit.verified();
    fake.unavailable = true;
    await person.client
      .post(`${API}/membership-plans/${plan.body.id}/subscribe`, {}, person.token)
      .expect(503);
    fake.unavailable = false;
    const membership = await person.client
      .post(`${API}/membership-plans/${plan.body.id}/subscribe`, {}, person.token)
      .expect(201);
    const providerId = (
      await prisma.membership.findUniqueOrThrow({ where: { id: membership.body.id } })
    ).providerSubscriptionId!;
    fake.setSubscriptionStatus(providerId, 'AUTHORIZED');
    const synced = await person.client
      .post(`${API}/users/me/memberships/${membership.body.id}/sync`, {}, person.token)
      .expect(200);
    expect(synced.body.status).toBe('ACTIVE');
    // Pendiente sin pagar: cancelar la anula.
    const again = await person.client
      .post(`${API}/membership-plans/${plan.body.id}/subscribe`, {}, person.token)
      .expect(409);
    expect(again.body.code).toBe('CONFLICT');
  });
});
