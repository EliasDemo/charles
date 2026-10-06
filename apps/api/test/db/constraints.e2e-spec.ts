import { randomUUID } from 'node:crypto';
import { OTHER_CATEGORY_ID } from '../../prisma/seed/categories';
import { dbErrorInfo, isContention, isExclusionViolation } from '../../src/common/errors/db-error';
import type { PrismaClient } from '../../src/generated/prisma/client';
import {
  bookingScenario,
  createTestPrisma,
  expectConstraintViolation,
  fixtures,
  randomHash,
  truncateAll,
} from '../support/db';

const at = (iso: string): Date => new Date(iso);
const time = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);

describe('Restricciones de la base de datos (integración, charles_test)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  beforeEach(() => truncateAll(prisma));
  afterAll(() => prisma.$disconnect());

  describe('RF-RES-007: sin reservas solapadas del mismo barbero (bookings_no_overlap)', () => {
    it('rechaza una reserva activa que se solapa con otra del mismo barbero', async () => {
      const { f, ids } = await bookingScenario(prisma);
      await f.booking(ids(), { startAt: at('2030-01-07T15:00:00Z') });
      await expectConstraintViolation(
        f.booking(ids(), { startAt: at('2030-01-07T15:15:00Z') }),
        'bookings_no_overlap',
      );
    });

    it('dbErrorInfo extrae el SQLSTATE 23P01 y la restricción del error real de Prisma', async () => {
      const { f, ids } = await bookingScenario(prisma);
      await f.booking(ids(), { startAt: at('2030-01-07T15:00:00Z') });
      let error: unknown;
      try {
        await f.booking(ids(), { startAt: at('2030-01-07T15:15:00Z') });
      } catch (caught) {
        error = caught;
      }
      const info = dbErrorInfo(error);
      expect(info?.pgCode).toBe('23P01');
      expect(isExclusionViolation(info)).toBe(true);
      expect(isContention(info)).toBe(false);
    });

    it('PENDING_PAYMENT también bloquea el horario', async () => {
      const { f, ids } = await bookingScenario(prisma);
      await f.booking(ids(), {
        status: 'PENDING_PAYMENT',
        expiresAt: at('2030-01-07T14:10:00Z'),
      });
      await expectConstraintViolation(f.booking(ids()), 'bookings_no_overlap');
    });

    it('permite reservas contiguas (intervalo [inicio, fin))', async () => {
      const { f, ids } = await bookingScenario(prisma);
      await f.booking(ids(), { startAt: at('2030-01-07T15:00:00Z') });
      await expect(
        f.booking(ids(), { startAt: at('2030-01-07T15:30:00Z') }),
      ).resolves.toBeDefined();
    });

    it('permite el mismo horario con otro barbero', async () => {
      const { f, ids, barberB } = await bookingScenario(prisma);
      await f.booking(ids());
      await expect(f.booking(ids(barberB.id))).resolves.toBeDefined();
    });

    it.each(['CANCELLED', 'EXPIRED', 'ATTENDED', 'NO_SHOW'] as const)(
      'una reserva %s no bloquea el horario',
      async (status) => {
        const { f, ids } = await bookingScenario(prisma);
        await f.booking(ids(), { status });
        await expect(f.booking(ids())).resolves.toBeDefined();
      },
    );

    it('dos inserciones simultáneas del mismo turno: exactamente una tiene éxito', async () => {
      const { f, ids } = await bookingScenario(prisma);
      const results = await Promise.allSettled([f.booking(ids()), f.booking(ids())]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.booking.count()).toBe(1);
    });
  });

  describe('invariantes de reservas', () => {
    it('end_at debe ser posterior a start_at', async () => {
      const { f, ids } = await bookingScenario(prisma);
      await expectConstraintViolation(
        f.booking(ids(), {
          startAt: at('2030-01-07T15:00:00Z'),
          endAt: at('2030-01-07T15:00:00Z'),
        }),
        'bookings_time_check',
      );
    });

    it('ADR 0002: total = subtotal − descuentos + cargos (impuestos incluidos)', async () => {
      const { f, ids } = await bookingScenario(prisma);
      await expect(
        f.booking(ids(), {
          subtotalAmount: 4000,
          discountTotalAmount: 500,
          feeTotalAmount: 200,
          totalAmount: 3700,
        }),
      ).resolves.toBeDefined();
      await expectConstraintViolation(
        f.booking(ids(), {
          startAt: at('2030-01-08T15:00:00Z'),
          subtotalAmount: 4000,
          totalAmount: 4720,
        }),
        'bookings_total_check',
      );
    });

    it('las líneas TAX son informativas: no alteran el total de la reserva', async () => {
      const { f, ids } = await bookingScenario(prisma);
      const booking = await f.booking(ids());
      await prisma.bookingPriceLine.createMany({
        data: [
          { bookingId: booking.id, type: 'SERVICE', description: 'Corte', amount: 2500 },
          { bookingId: booking.id, type: 'TAX', description: 'IGV incluido', amount: 381 },
        ],
      });
      const stored = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(stored.totalAmount).toBe(2500);
    });

    it('rechaza montos negativos', async () => {
      const { f, ids } = await bookingScenario(prisma);
      await expectConstraintViolation(
        f.booking(ids(), { discountTotalAmount: -100, totalAmount: 2600 }),
        'bookings_amounts_check',
      );
      const booking = await f.booking(ids());
      await expectConstraintViolation(
        prisma.bookingPriceLine.create({
          data: { bookingId: booking.id, type: 'DISCOUNT', description: 'x', amount: -1 },
        }),
        'booking_price_lines_amount_check',
      );
    });

    it('PENDING_PAYMENT exige expires_at', async () => {
      const { f, ids } = await bookingScenario(prisma);
      await expectConstraintViolation(
        f.booking(ids(), { status: 'PENDING_PAYMENT', expiresAt: null }),
        'bookings_pending_expires_check',
      );
    });

    it('exige moneda ISO 4217', async () => {
      const { f, ids } = await bookingScenario(prisma);
      await expectConstraintViolation(
        f.booking(ids(), { currency: 'pen' }),
        'bookings_currency_check',
      );
    });

    it('Idempotency-Key única por cliente, no global', async () => {
      const { f, ids, shop, barberB, service } = await bookingScenario(prisma);
      const key = randomUUID();
      await f.booking(ids(), { idempotencyKey: key });
      await expectConstraintViolation(
        f.booking(ids(barberB.id), { idempotencyKey: key }),
        'bookings_client_id_idempotency_key_key',
      );
      const otherClient = await f.user();
      await expect(
        f.booking(
          {
            clientId: otherClient.id,
            barbershopId: shop.id,
            barberId: barberB.id,
            serviceId: service.id,
          },
          { idempotencyKey: key },
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('pagos', () => {
    it('idempotency_key única por reserva y provider_payment_id único por proveedor', async () => {
      const { f, ids } = await bookingScenario(prisma);
      const booking = await f.booking(ids());
      const base = { bookingId: booking.id, provider: 'FAKE', amount: 2500, currency: 'PEN' };
      await prisma.payment.create({
        data: { ...base, idempotencyKey: 'k1', providerPaymentId: 'p1' },
      });
      await expectConstraintViolation(
        prisma.payment.create({ data: { ...base, idempotencyKey: 'k1' } }),
        'payments_booking_id_idempotency_key_key',
      );
      await expectConstraintViolation(
        prisma.payment.create({ data: { ...base, idempotencyKey: 'k2', providerPaymentId: 'p1' } }),
        'payments_provider_provider_payment_id_key',
      );
      await expect(
        prisma.payment.create({
          data: { ...base, provider: 'IZIPAY', idempotencyKey: 'k3', providerPaymentId: 'p1' },
        }),
      ).resolves.toBeDefined();
    });

    it('evento de pasarela único por proveedor (idempotencia de webhooks)', async () => {
      const data = {
        provider: 'FAKE',
        providerEventId: 'evt-1',
        type: 'payment.succeeded',
        payload: {},
      };
      await prisma.paymentEvent.create({ data });
      await expectConstraintViolation(
        prisma.paymentEvent.create({ data }),
        'payment_events_provider_provider_event_id_key',
      );
    });

    it('rechaza montos de pago no positivos', async () => {
      const { f, ids } = await bookingScenario(prisma);
      const booking = await f.booking(ids());
      await expectConstraintViolation(
        prisma.payment.create({
          data: {
            bookingId: booking.id,
            provider: 'FAKE',
            amount: 0,
            currency: 'PEN',
            idempotencyKey: 'k',
          },
        }),
        'payments_amount_check',
      );
    });
  });

  describe('cuentas', () => {
    it('email_hash es único', async () => {
      const f = fixtures(prisma);
      const emailHash = randomHash();
      await f.user({ emailHash });
      await expectConstraintViolation(f.user({ emailHash }), 'users_email_hash_key');
    });

    it('document_hash es único solo cuando no es nulo', async () => {
      const f = fixtures(prisma);
      await f.user({ documentHash: null });
      await expect(f.user({ documentHash: null })).resolves.toBeDefined();
      const documentHash = randomHash();
      await f.user({ documentHash });
      await expectConstraintViolation(f.user({ documentHash }), 'users_document_hash_key');
    });

    it('phone_hash no es único', async () => {
      const f = fixtures(prisma);
      const phoneHash = randomHash();
      await f.user({ phoneHash });
      await expect(f.user({ phoneHash })).resolves.toBeDefined();
    });

    it('un rol por usuario una sola vez', async () => {
      const user = await fixtures(prisma).user();
      await prisma.userRole.create({ data: { userId: user.id, role: 'CLIENT' } });
      await expectConstraintViolation(
        prisma.userRole.create({ data: { userId: user.id, role: 'CLIENT' } }),
        'user_roles_user_id_role_key',
      );
    });
  });

  describe('barberías, barberos, servicios y horarios', () => {
    it('location se genera desde latitud y longitud', async () => {
      const shop = await fixtures(prisma).barbershop();
      const [row] = await prisma.$queryRaw<{ lat: number; lng: number }[]>`
        SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
        FROM barbershops WHERE id = ${shop.id}::uuid`;
      expect(row).toEqual({ lat: -12.1, lng: -77.03 });
    });

    it('rechaza coordenadas fuera de rango', async () => {
      await expectConstraintViolation(
        prisma.barbershop.create({
          data: { name: 'x', address: 'x', latitude: 91, longitude: 0, timezone: 'America/Lima' },
        }),
        'barbershops_latitude_check',
      );
    });

    it('MVP: un usuario es barbero activo en una sola barbería', async () => {
      const f = fixtures(prisma);
      const user = await f.user();
      const [shopA, shopB] = [await f.barbershop(), await f.barbershop()];
      const barber = await f.barber(shopA.id, user.id);
      await expectConstraintViolation(f.barber(shopB.id, user.id), 'barbers_user_id_active_key');
      await prisma.barber.update({ where: { id: barber.id }, data: { deletedAt: new Date() } });
      await expect(f.barber(shopB.id, user.id)).resolves.toBeDefined();
    });

    it('servicio con precio no negativo y duración positiva', async () => {
      const shop = await fixtures(prisma).barbershop();
      const base = {
        barbershopId: shop.id,
        name: 'x',
        currency: 'PEN',
        categoryId: OTHER_CATEGORY_ID,
      };
      await expectConstraintViolation(
        prisma.service.create({ data: { ...base, priceAmount: -1, durationMinutes: 30 } }),
        'services_price_amount_check',
      );
      await expectConstraintViolation(
        prisma.service.create({ data: { ...base, priceAmount: 100, durationMinutes: 0 } }),
        'services_duration_minutes_check',
      );
    });

    it('horarios sin cruzar la medianoche y día de semana 0–6', async () => {
      const shop = await fixtures(prisma).barbershop();
      await expectConstraintViolation(
        prisma.businessHour.create({
          data: {
            barbershopId: shop.id,
            dayOfWeek: 5,
            openTime: time('18:00'),
            closeTime: time('01:00'),
          },
        }),
        'business_hours_time_check',
      );
      await expectConstraintViolation(
        prisma.businessHour.create({
          data: {
            barbershopId: shop.id,
            dayOfWeek: 7,
            openTime: time('09:00'),
            closeTime: time('18:00'),
          },
        }),
        'business_hours_day_of_week_check',
      );
      const barber = await fixtures(prisma).barber(shop.id);
      await expectConstraintViolation(
        prisma.barberSchedule.create({
          data: {
            barberId: barber.id,
            dayOfWeek: 1,
            startTime: time('14:00'),
            endTime: time('13:00'),
          },
        }),
        'barber_schedules_time_check',
      );
    });

    it('bloqueos con fin posterior al inicio', async () => {
      const shop = await fixtures(prisma).barbershop();
      await expectConstraintViolation(
        prisma.timeBlock.create({
          data: {
            barbershopId: shop.id,
            startAt: at('2030-01-07T15:00:00Z'),
            endAt: at('2030-01-07T14:00:00Z'),
            type: 'ABSENCE',
          },
        }),
        'time_blocks_time_check',
      );
    });
  });

  describe('valoraciones', () => {
    it('una valoración por reserva y rating entre 1 y 5', async () => {
      const { f, ids, client, shop, barberA } = await bookingScenario(prisma);
      const booking = await f.booking(ids(), { status: 'ATTENDED' });
      const base = {
        bookingId: booking.id,
        clientId: client.id,
        barbershopId: shop.id,
        barberId: barberA.id,
      };
      await expectConstraintViolation(
        prisma.review.create({ data: { ...base, rating: 6 } }),
        'reviews_rating_check',
      );
      await prisma.review.create({ data: { ...base, rating: 5 } });
      await expectConstraintViolation(
        prisma.review.create({ data: { ...base, rating: 4 } }),
        'reviews_booking_id_key',
      );
    });
  });

  describe('promociones', () => {
    const base = {
      name: 'Promo',
      startsAt: at('2030-01-01T00:00:00Z'),
    };

    it('porcentaje entre 1 y 100', async () => {
      await expectConstraintViolation(
        prisma.promotion.create({
          data: { ...base, scope: 'PLATFORM', type: 'PERCENTAGE', value: 101 },
        }),
        'promotions_value_check',
      );
    });

    it('monto fijo exige moneda', async () => {
      await expectConstraintViolation(
        prisma.promotion.create({
          data: { ...base, scope: 'PLATFORM', type: 'FIXED_AMOUNT', value: 500 },
        }),
        'promotions_fixed_currency_check',
      );
    });

    it('scope_id nulo solo con alcance PLATFORM', async () => {
      await expectConstraintViolation(
        prisma.promotion.create({
          data: { ...base, scope: 'BARBERSHOP', type: 'PERCENTAGE', value: 10 },
        }),
        'promotions_scope_check',
      );
      await expectConstraintViolation(
        prisma.promotion.create({
          data: {
            ...base,
            scope: 'PLATFORM',
            scopeId: randomUUID(),
            type: 'PERCENTAGE',
            value: 10,
          },
        }),
        'promotions_scope_check',
      );
    });

    it('códigos de cupón únicos sin distinguir mayúsculas (citext)', async () => {
      const promo = await prisma.promotion.create({
        data: { ...base, scope: 'PLATFORM', type: 'PERCENTAGE', value: 10 },
      });
      await prisma.coupon.create({ data: { promotionId: promo.id, code: 'BIENVENIDA' } });
      await expectConstraintViolation(
        prisma.coupon.create({ data: { promotionId: promo.id, code: 'bienvenida' } }),
        'coupons_code_key',
      );
    });
  });

  describe('audit_log es de solo inserción', () => {
    it('permite insertar y rechaza UPDATE, DELETE y TRUNCATE', async () => {
      const entry = await prisma.auditLog.create({
        data: { action: 'test.inserted', entityType: 'test', entityId: randomUUID() },
      });
      await expectConstraintViolation(
        prisma.auditLog.update({ where: { id: entry.id }, data: { action: 'cambiado' } }),
        'audit_log es de solo inserción',
      );
      await expectConstraintViolation(
        prisma.auditLog.delete({ where: { id: entry.id } }),
        'audit_log es de solo inserción',
      );
      await expectConstraintViolation(
        prisma.$executeRawUnsafe('TRUNCATE TABLE audit_log'),
        'audit_log es de solo inserción',
      );
    });
  });
});
