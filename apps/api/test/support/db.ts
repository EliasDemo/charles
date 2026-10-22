import { randomBytes, randomUUID } from 'node:crypto';
import { OTHER_CATEGORY_ID } from '../../prisma/seed/categories';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

/** Cliente Prisma contra `charles_test` (load-test-env garantiza que no es otra base). */
export function createTestPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
}

/**
 * Vacía las tablas de negocio de `charles_test` entre pruebas.
 * `audit_log` queda fuera: es de solo inserción (su trigger rechaza TRUNCATE).
 * `service_categories`, `service_styles` y `face_shape_rules` también: son datos de referencia (los
 * carga global-setup).
 */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations', 'audit_log', 'spatial_ref_sys', 'service_categories', 'service_styles', 'face_shape_rules', 'peru_districts')`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  // Nombres obtenidos del catálogo (no de entrada externa).
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Espera que la operación falle por la restricción indicada (por nombre). */
export async function expectConstraintViolation(
  operation: Promise<unknown>,
  constraint: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(describeError(error)).toContain(constraint);
}

export function describeError(error: unknown): string {
  const seen = new WeakSet();
  return (
    JSON.stringify(error, (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return undefined;
        seen.add(value);
      }
      return value;
    }) + String((error as Error)?.message ?? '')
  );
}

/** 32 bytes aleatorios con el tipo que Prisma espera para columnas Bytes. */
export function randomHash(): Buffer<ArrayBuffer> {
  return Buffer.from(randomBytes(32));
}

/** Fábricas mínimas de datos ficticios para probar restricciones. */
export function fixtures(prisma: PrismaClient) {
  const hash = (): Buffer<ArrayBuffer> => randomHash();

  return {
    user: (
      data: {
        documentHash?: Buffer<ArrayBuffer> | null;
        phoneHash?: Buffer<ArrayBuffer> | null;
        emailHash?: Buffer<ArrayBuffer>;
      } = {},
    ) =>
      prisma.user.create({
        data: {
          emailEnc: 'v1:fixture',
          emailHash: data.emailHash ?? hash(),
          username: `fx_${randomBytes(6).toString('hex')}`,
          passwordHash: 'fixture',
          fullName: 'Usuario de prueba',
          phoneHash: data.phoneHash ?? null,
          documentHash: data.documentHash ?? null,
          termsAcceptedAt: new Date(),
          termsVersion: 'test',
        },
      }),

    barbershop: () =>
      prisma.barbershop.create({
        data: {
          name: 'Barbería de prueba',
          address: 'Dirección ficticia',
          latitude: -12.1,
          longitude: -77.03,
          timezone: 'America/Lima',
        },
      }),

    barber: (barbershopId: string, userId: string | null = null) =>
      prisma.barber.create({ data: { barbershopId, userId, displayName: 'Barbero de prueba' } }),

    service: (barbershopId: string) =>
      prisma.service.create({
        data: {
          barbershopId,
          name: 'Corte',
          priceAmount: 2500,
          currency: 'PEN',
          categoryId: OTHER_CATEGORY_ID,
          durationMinutes: 30,
        },
      }),

    /** Reserva válida; `overrides` permite romper invariantes a propósito. */
    booking: (
      ids: { clientId: string; barbershopId: string; barberId: string; serviceId: string },
      overrides: Partial<{
        startAt: Date;
        endAt: Date;
        status: 'PENDING_PAYMENT' | 'CONFIRMED' | 'ATTENDED' | 'CANCELLED' | 'NO_SHOW' | 'EXPIRED';
        expiresAt: Date | null;
        subtotalAmount: number;
        discountTotalAmount: number;
        feeTotalAmount: number;
        totalAmount: number;
        currency: string;
        idempotencyKey: string;
      }> = {},
    ) => {
      const startAt = overrides.startAt ?? new Date('2030-01-07T15:00:00Z');
      return prisma.booking.create({
        data: {
          ...ids,
          startAt,
          endAt: overrides.endAt ?? new Date(startAt.getTime() + 30 * 60_000),
          status: overrides.status ?? 'CONFIRMED',
          // CHECK bookings_cancelled_by_role_check: el rol existe si y solo si está cancelada.
          cancelledByRole: overrides.status === 'CANCELLED' ? 'CLIENT' : null,
          expiresAt: overrides.expiresAt === undefined ? null : overrides.expiresAt,
          barberChosenByClient: true,
          serviceNameSnapshot: 'Corte',
          durationMinutesSnapshot: 30,
          subtotalAmount: overrides.subtotalAmount ?? 2500,
          discountTotalAmount: overrides.discountTotalAmount ?? 0,
          feeTotalAmount: overrides.feeTotalAmount ?? 0,
          totalAmount: overrides.totalAmount ?? 2500,
          currency: overrides.currency ?? 'PEN',
          idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
        },
      });
    },
  };
}

/** Escenario base: cliente, barbería, dos barberos y un servicio. */
export async function bookingScenario(prisma: PrismaClient) {
  const f = fixtures(prisma);
  const client = await f.user();
  const shop = await f.barbershop();
  const [barberA, barberB] = [await f.barber(shop.id), await f.barber(shop.id)];
  const service = await f.service(shop.id);
  const ids = (barberId = barberA.id) => ({
    clientId: client.id,
    barbershopId: shop.id,
    barberId,
    serviceId: service.id,
  });
  return { f, client, shop, barberA, barberB, service, ids };
}
