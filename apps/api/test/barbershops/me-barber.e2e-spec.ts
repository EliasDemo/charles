import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { ownerWithShop } from '../support/barbershops';

const API = '/api/v1';

describe('GET /me/barber: perfiles de barbero propios (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  it('sin sesión: 401', async () => {
    await new AuthClient(app).get(`${API}/me/barber`).expect(401);
  });

  it('una cuenta sin perfil de barbero recibe la lista vacía', async () => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    const res = await client.get(`${API}/me/barber`, tokens.accessToken).expect(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('RF-BRB-001 el responsable que se registra como barbero ve su perfil con su barbería', async () => {
    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    const service = await client
      .post(
        `${API}/barbershops/${owner.shopId}/services`,
        { name: 'Corte', priceAmount: 2500, durationMinutes: 30, categoryKey: 'haircut' },
        owner.token,
      )
      .expect(201);
    const barber = await client
      .post(
        `${API}/barbershops/${owner.shopId}/barbers/me`,
        { displayName: 'Ana', serviceIds: [service.body.id] },
        owner.token,
      )
      .expect(201);
    const res = await client.get(`${API}/me/barber`, owner.token).expect(200);
    expect(res.body.items).toEqual([
      {
        barberId: barber.body.id,
        displayName: 'Ana',
        isActive: true,
        serviceIds: [service.body.id],
        barbershop: {
          id: owner.shopId,
          name: 'Barbería E2E',
          status: 'OPEN',
          timezone: 'America/Lima',
        },
      },
    ]);
    // Sin datos personales del perfil (teléfono) ni de otros.
    expect(JSON.stringify(res.body)).not.toMatch(/phone|email/i);
  });

  it('cada cuenta ve solo sus perfiles; los inactivos aparecen marcados y los de barberías eliminadas no', async () => {
    const ownerClient = new AuthClient(app);
    const owner = await ownerWithShop(ownerClient);
    const created = await ownerClient
      .post(`${API}/barbershops/${owner.shopId}/barbers`, { displayName: 'Pedro' }, owner.token)
      .expect(201);
    const accountClient = new AuthClient(app);
    const account = await accountClient.newUser();
    // Atajo de datos de prueba: la vinculación por invitación ya se prueba en la Fase 4.
    await prisma.barber.update({
      where: { id: created.body.id },
      data: { userId: account.tokens.user.id },
    });

    // El responsable no ve el perfil del barbero como propio.
    const ownerView = await ownerClient.get(`${API}/me/barber`, owner.token).expect(200);
    expect(ownerView.body.items).toEqual([]);

    await ownerClient
      .patch(
        `${API}/barbershops/${owner.shopId}/barbers/${created.body.id}`,
        { isActive: false },
        owner.token,
      )
      .expect(200);
    const inactive = await accountClient
      .get(`${API}/me/barber`, account.tokens.accessToken)
      .expect(200);
    expect(inactive.body.items).toEqual([
      expect.objectContaining({ barberId: created.body.id, isActive: false }),
    ]);

    await prisma.barbershop.update({
      where: { id: owner.shopId },
      data: { deletedAt: new Date() },
    });
    const gone = await accountClient
      .get(`${API}/me/barber`, account.tokens.accessToken)
      .expect(200);
    expect(gone.body.items).toEqual([]);
  });
});
