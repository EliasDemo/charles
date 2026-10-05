import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { type AuthClient, codeFrom, waitForMail } from './auth';

export function shopPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Barbería E2E',
    address: 'Av. Prueba 123, Miraflores, Lima',
    latitude: -12.12,
    longitude: -77.03,
    phone: '+51 1 234 5678',
    ...overrides,
  };
}

/** Cuenta con sesión y una barbería propia (OWNER). */
export async function ownerWithShop(
  client: AuthClient,
  overrides: Record<string, unknown> = {},
): Promise<{ email: string; password: string; token: string; userId: string; shopId: string }> {
  const { email, password, tokens } = await client.newUser();
  const res = await client
    .post('/api/v1/barbershops', shopPayload(overrides), tokens.accessToken)
    .expect(201);
  return {
    email,
    password,
    token: tokens.accessToken,
    userId: tokens.user.id,
    shopId: res.body.id as string,
  };
}

/** Invita (como OWNER) a una cuenta existente y la hace aceptar con el código del correo. */
export async function inviteAndAccept(
  app: NestExpressApplication,
  owner: { client: AuthClient; token: string; shopId: string },
  invitee: { client: AuthClient; email: string; token: string },
  role: 'OWNER' | 'MANAGER',
): Promise<void> {
  await owner.client
    .post(
      `/api/v1/barbershops/${owner.shopId}/members/invitations`,
      { email: invitee.email, role },
      owner.token,
    )
    .expect(202);
  const code = codeFrom(await waitForMail(app, invitee.email, 'member-invitation'));
  const list = await invitee.client
    .get('/api/v1/me/barbershop-invitations', invitee.token)
    .expect(200);
  const invitation = (list.body.items as { id: string; barbershopId: string }[]).find(
    (i) => i.barbershopId === owner.shopId,
  );
  if (!invitation) throw new Error('No aparece la invitación');
  await invitee.client
    .post(`/api/v1/me/barbershop-invitations/${invitation.id}/accept`, { code }, invitee.token)
    .expect(204);
}

/** Reserva futura confirmada (para probar reglas de "reservas futuras"), directo en charles_test. */
export async function futureBooking(
  app: NestExpressApplication,
  ids: { barbershopId: string; barberId: string; serviceId: string; clientId: string },
): Promise<void> {
  const startAt = new Date(Date.now() + 7 * 24 * 3600_000);
  await app.get(PrismaService).booking.create({
    data: {
      ...ids,
      startAt,
      endAt: new Date(startAt.getTime() + 30 * 60_000),
      status: 'CONFIRMED',
      barberChosenByClient: true,
      serviceNameSnapshot: 'Corte',
      durationMinutesSnapshot: 30,
      subtotalAmount: 2500,
      totalAmount: 2500,
      currency: 'PEN',
      idempotencyKey: `test-${startAt.getTime()}-${Math.random()}`,
    },
  });
}
