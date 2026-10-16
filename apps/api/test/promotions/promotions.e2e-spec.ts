import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
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
import { staffToken } from '../support/mfa';

const TUESDAY = '2030-01-08';

/** Fase 13A: promociones, cupones, cotización y descuento en la reserva. */
describe('Promociones y cupones (e2e, Fase 13)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
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
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
  });
  afterAll(() => app.close());

  async function admin(): Promise<Person> {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    const p: Person = { client, token: tokens.accessToken, userId: tokens.user.id, email };
    await prisma.userRole.create({ data: { userId: p.userId, role: 'ADMIN' } });
    p.token = await staffToken(app, p);
    return p;
  }

  const promotions = (shop: KitShop) => `${API}/barbershops/${shop.shopId}/promotions`;

  async function shopPromotion(shop: KitShop, body: Record<string, unknown>) {
    const res = await shop.owner.client
      .post(
        promotions(shop),
        { name: 'Promo de la casa', type: 'PERCENTAGE', value: 20, ...body },
        shop.owner.token,
      )
      .expect(201);
    return res.body as { id: string };
  }

  function quote(
    who: Person,
    shop: KitShop,
    extra: Record<string, unknown> = {},
    at = lima(MONDAY, '12:00'),
  ) {
    return who.client.post(
      `${API}/bookings/quote`,
      {
        barbershopId: shop.shopId,
        serviceId: shop.serviceId,
        startAt: new Date(at).toISOString(),
        ...extra,
      },
      who.token,
    );
  }

  function book(
    who: Person,
    shop: KitShop,
    extra: Record<string, unknown> = {},
    at = lima(MONDAY, '12:00'),
  ) {
    return who.client
      .post(
        `${API}/bookings`,
        {
          barbershopId: shop.shopId,
          serviceId: shop.serviceId,
          startAt: new Date(at).toISOString(),
          barberId: shop.barberId,
          ...extra,
        },
        who.token,
      )
      .set('Idempotency-Key', randomUUID());
  }

  const money = (amount: number) => ({ amount, currency: 'PEN' });

  it('promoción automática de la barbería: cotización, reserva con línea DISCOUNT y canje', async () => {
    const shop = await kit.shopReady();
    const promo = await shopPromotion(shop, {});
    const client = await kit.verified();

    const q = await quote(client, shop).expect(200);
    expect(q.body).toEqual({
      subtotal: money(2500),
      discountTotal: money(500),
      feeTotal: money(0),
      total: money(2000),
      lines: [
        { type: 'SERVICE', description: 'Corte', amount: money(2500) },
        { type: 'DISCOUNT', description: 'Promo de la casa', amount: money(500) },
        { type: 'FEE', description: 'Comisión de Charles', amount: money(0) },
      ],
      promotion: { id: promo.id, name: 'Promo de la casa' },
      coupon: null,
    });

    const res = await book(client, shop).expect(201);
    expect(res.body.price).toMatchObject({
      subtotal: money(2500),
      discountTotal: money(500),
      total: money(2000),
    });
    expect(res.body.price.lines.map((l: { type: string }) => l.type)).toEqual([
      'SERVICE',
      'DISCOUNT',
      'FEE',
    ]);
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId: res.body.id } });
    expect(payment.amount).toBe(2000);
    const redemption = await prisma.promotionRedemption.findUniqueOrThrow({
      where: { bookingId: res.body.id },
    });
    expect(redemption).toMatchObject({
      promotionId: promo.id,
      couponId: null,
      discountAmount: 500,
      fundedBy: 'BARBERSHOP',
      releasedAt: null,
    });

    const list = await shop.owner.client.get(promotions(shop), shop.owner.token).expect(200);
    expect(list.body[0]).toMatchObject({
      id: promo.id,
      scope: 'BARBERSHOP',
      status: 'ACTIVE',
      redemptions: 1,
      discountedTotal: money(500),
    });
  });

  it('la comisión se calcula sobre el precio con descuento', async () => {
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'fees.' } } });
    await prisma.appSetting.createMany({
      data: [
        { key: 'fees.percent_bp', value: 1000 },
        { key: 'fees.payer', value: 'CLIENT' },
      ],
    });
    try {
      const shop = await kit.shopReady();
      await shopPromotion(shop, {});
      const client = await kit.verified();
      const q = await quote(client, shop).expect(200);
      // 10 % de S/ 20.00 (ya descontado) = S/ 2.00, que paga el cliente.
      expect(q.body).toMatchObject({ feeTotal: money(200), total: money(2200) });
      const res = await book(client, shop).expect(201);
      expect(res.body.price.total).toEqual(money(2200));
      const booking = await prisma.booking.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(booking.commissionAmount).toBe(200);
    } finally {
      await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'fees.' } } });
    }
  });

  it('cupón de Charles: solo con código, sin importar mayúsculas, y una vez por cliente', async () => {
    const boss = await admin();
    const created = await boss.client
      .post(
        `${API}/admin/promotions`,
        {
          name: 'Bienvenida',
          type: 'FIXED_AMOUNT',
          value: 700,
          requiresCoupon: true,
          maxPerUser: 1,
        },
        boss.token,
      )
      .expect(201);
    expect(created.body).toMatchObject({ scope: 'PLATFORM', currency: 'PEN', barbershopId: null });
    const code = `HOLA${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await boss.client
      .post(
        `${API}/admin/promotions/${created.body.id}/coupons`,
        { code: code.toLowerCase() },
        boss.token,
      )
      .expect(201);

    const shop = await kit.shopReady();
    const client = await kit.verified();
    expect((await quote(client, shop).expect(200)).body.promotion).toBeNull();
    const withCode = await quote(client, shop, { couponCode: code.toLowerCase() }).expect(200);
    expect(withCode.body).toMatchObject({
      discountTotal: money(700),
      total: money(1800),
      coupon: { code, applied: true, reason: null },
    });

    const res = await book(client, shop, { couponCode: code }).expect(201);
    const redemption = await prisma.promotionRedemption.findUniqueOrThrow({
      where: { bookingId: res.body.id },
    });
    expect(redemption).toMatchObject({ fundedBy: 'CHARLES', discountAmount: 700 });
    expect(redemption.couponId).not.toBeNull();

    const again = await quote(client, shop, { couponCode: code }, lima(MONDAY, '13:00')).expect(
      200,
    );
    expect(again.body.coupon).toEqual({ code, applied: false, reason: 'ALREADY_USED' });
    const rejected = await book(client, shop, { couponCode: code }, lima(MONDAY, '13:00')).expect(
      409,
    );
    expect(rejected.body).toMatchObject({
      code: 'COUPON_NOT_VALID',
      message: 'Ya usaste este cupón.',
      details: [{ reason: 'ALREADY_USED' }],
    });
  });

  it('un solo descuento: gana el mayor y el cupón se informa como BETTER_PROMOTION', async () => {
    const shop = await kit.shopReady();
    const big = await shopPromotion(shop, { name: 'Gran promo', value: 30 });
    const small = await shopPromotion(shop, { name: 'Con cupón', value: 10, requiresCoupon: true });
    const code = `PEQ${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await shop.owner.client
      .post(`${promotions(shop)}/${small.id}/coupons`, { code }, shop.owner.token)
      .expect(201);
    const client = await kit.verified();
    const q = await quote(client, shop, { couponCode: code }).expect(200);
    expect(q.body).toMatchObject({
      discountTotal: money(750),
      promotion: { id: big.id },
      coupon: { code, applied: false, reason: 'BETTER_PROMOTION' },
    });
    await book(client, shop, { couponCode: code }).expect(201);
  });

  it('cupón inexistente, de otra barbería o no vigente: la cotización lo explica, la reserva lo rechaza', async () => {
    const shop = await kit.shopReady();
    const other = await kit.shopReady();
    const promo = await shopPromotion(other, { requiresCoupon: true });
    const code = `OTRA${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await other.owner.client
      .post(`${promotions(other)}/${promo.id}/coupons`, { code }, other.owner.token)
      .expect(201);
    const client = await kit.verified();

    expect(
      (await quote(client, shop, { couponCode: 'NOEXISTE1' }).expect(200)).body.coupon,
    ).toEqual({
      code: 'NOEXISTE1',
      applied: false,
      reason: 'NOT_FOUND',
    });
    expect((await quote(client, shop, { couponCode: code }).expect(200)).body.coupon.reason).toBe(
      'NOT_APPLICABLE',
    );
    await other.owner.client
      .patch(`${promotions(other)}/${promo.id}`, { isActive: false }, other.owner.token)
      .expect(200);
    expect((await quote(client, other, { couponCode: code }).expect(200)).body.coupon.reason).toBe(
      'NOT_ACTIVE',
    );
    const res = await book(client, shop, { couponCode: 'NOEXISTE1' }).expect(409);
    expect(res.body.details).toEqual([{ reason: 'NOT_FOUND' }]);
    // Nada quedó a medias.
    expect(await prisma.booking.count({ where: { clientId: client.userId } })).toBe(0);
  });

  it('tope total: el cupo se libera al cancelar y otro cliente lo usa', async () => {
    const shop = await kit.shopReady();
    await shopPromotion(shop, { maxRedemptions: 1 });
    const first = await kit.verified();
    const second = await kit.verified();
    const taken = await book(first, shop).expect(201);
    expect(taken.body.price.discountTotal).toEqual(money(500));
    expect(
      (await quote(second, shop, {}, lima(MONDAY, '13:00')).expect(200)).body.promotion,
    ).toBeNull();

    await first.client.post(`${API}/bookings/${taken.body.id}/cancel`, {}, first.token).expect(200);
    const released = await prisma.promotionRedemption.findUniqueOrThrow({
      where: { bookingId: taken.body.id },
    });
    expect(released.releasedAt).not.toBeNull();
    const reused = await book(second, shop, {}, lima(MONDAY, '13:00')).expect(201);
    expect(reused.body.price.discountTotal).toEqual(money(500));
  });

  it('dos reservas a la vez por el último cupo con cupón: una lo usa y la otra recibe 409', async () => {
    const shop = await kit.shopReady();
    const promo = await shopPromotion(shop, { requiresCoupon: true, maxRedemptions: 1 });
    const code = `UNO${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await shop.owner.client
      .post(`${promotions(shop)}/${promo.id}/coupons`, { code }, shop.owner.token)
      .expect(201);
    const [a, b] = [await kit.verified(), await kit.verified()];
    const results = await Promise.all([
      book(a, shop, { couponCode: code }, lima(MONDAY, '12:00')),
      book(b, shop, { couponCode: code }, lima(MONDAY, '14:00')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.promotionRedemption.count({ where: { promotionId: promo.id } })).toBe(1);
  });

  it('promoción por día y por servicio; la vista pública muestra solo las automáticas vigentes', async () => {
    const shop = await kit.shopReady();
    const tuesday = await shopPromotion(shop, {
      name: 'Martes',
      serviceId: shop.serviceId,
      daysOfWeek: [2],
    });
    await shopPromotion(shop, { name: 'Secreta', requiresCoupon: true });
    const client = await kit.verified();
    expect((await quote(client, shop).expect(200)).body.promotion).toBeNull();
    expect(
      (await quote(client, shop, {}, lima(TUESDAY, '12:00')).expect(200)).body.promotion,
    ).toEqual({ id: tuesday.id, name: 'Martes' });

    const visible = await new AuthClient(app).get(`${promotions(shop)}/active`).expect(200);
    expect(visible.body).toEqual([
      expect.objectContaining({
        id: tuesday.id,
        serviceId: shop.serviceId,
        daysOfWeek: [2],
        fromCharles: false,
      }),
    ]);
  });

  it('validaciones y permisos', async () => {
    const shop = await kit.shopReady();
    const other = await kit.shopReady();
    const post = (body: Record<string, unknown>) =>
      shop.owner.client.post(
        promotions(shop),
        { name: 'X promo', type: 'PERCENTAGE', value: 10, ...body },
        shop.owner.token,
      );
    expect((await post({ value: 101 }).expect(400)).body.code).toBe('VALIDATION_ERROR');
    expect((await post({ type: 'FIXED_AMOUNT', value: 50 }).expect(400)).body.details).toEqual([
      { field: 'value', constraints: ['fixedAmountRange'] },
    ]);
    expect(
      (await post({ startsAt: '2030-02-01T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' }).expect(400))
        .body.details,
    ).toEqual([{ field: 'endsAt', constraints: ['afterStartsAt'] }]);
    expect((await post({ serviceId: other.serviceId }).expect(400)).body.details).toEqual([
      { field: 'serviceId', constraints: ['serviceOfBarbershop'] },
    ]);
    // Quien no es responsable no ve ni crea (404, como el resto de la gestión).
    const stranger = await kit.verified();
    await stranger.client.get(promotions(shop), stranger.token).expect(404);

    const promo = await shopPromotion(shop, { requiresCoupon: true });
    const code = `DUP${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await shop.owner.client
      .post(`${promotions(shop)}/${promo.id}/coupons`, { code }, shop.owner.token)
      .expect(201);
    const dup = await shop.owner.client
      .post(`${promotions(shop)}/${promo.id}/coupons`, { code }, shop.owner.token)
      .expect(409);
    expect(dup.body.code).toBe('COUPON_CODE_TAKEN');
    await shop.owner.client
      .post(`${promotions(shop)}/${promo.id}/coupons`, { code: 'con espacio' }, shop.owner.token)
      .expect(400);
    // Otra barbería no toca esta promoción.
    await other.owner.client
      .patch(`${promotions(other)}/${promo.id}`, { isActive: false }, other.owner.token)
      .expect(404);

    // /admin/promotions: solo ADMIN, y las de Charles no llevan servicio.
    const boss = await admin();
    await boss.client
      .post(
        `${API}/admin/promotions`,
        { name: 'Mal', type: 'PERCENTAGE', value: 5, serviceId: shop.serviceId },
        boss.token,
      )
      .expect(400);
    await shop.owner.client.get(`${API}/admin/promotions`, shop.owner.token).expect(403);
    const all = await boss.client
      .get(`${API}/admin/promotions?barbershopId=${shop.shopId}`, boss.token)
      .expect(200);
    expect(all.body.map((p: { id: string }) => p.id)).toContain(promo.id);
    // ADMIN puede pausar la de una barbería.
    const paused = await boss.client
      .patch(`${API}/admin/promotions/${promo.id}`, { isActive: false }, boss.token)
      .expect(200);
    expect(paused.body.status).toBe('PAUSED');
  });
});
