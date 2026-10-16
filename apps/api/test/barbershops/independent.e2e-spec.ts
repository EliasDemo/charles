import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { ownerWithShop, shopPayload } from '../support/barbershops';

const SHOPS = '/api/v1/barbershops';
const INDEPENDENT = `${SHOPS}/independent`;

describe('Barbero independiente (RF-BAR-001, RF-BRB-001) (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  const rolesOf = async (userId: string): Promise<string[]> =>
    (await prisma.userRole.findMany({ where: { userId } })).map((r) => r.role).sort();

  async function independent(overrides: Record<string, unknown> = {}) {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    const res = await client
      .post(
        INDEPENDENT,
        shopPayload({ name: 'Carlos Barber', displayName: 'Carlos', ...overrides }),
        tokens.accessToken,
      )
      .expect(201);
    return {
      client,
      token: tokens.accessToken,
      userId: tokens.user.id,
      shopId: res.body.id as string,
      barberId: res.body.barberId as string,
      body: res.body,
    };
  }

  it('RF-BAR-001: en una transacción crea la barbería INDEPENDENT, el OWNER y su barbero activo', async () => {
    const ind = await independent();
    expect(ind.body).toMatchObject({
      type: 'INDEPENDENT',
      status: 'OPEN',
      myRole: 'OWNER',
      ownerRoleGranted: true,
      barberRoleGranted: true,
    });

    const member = await prisma.barbershopMember.findFirstOrThrow({
      where: { barbershopId: ind.shopId },
    });
    expect(member).toMatchObject({ userId: ind.userId, role: 'OWNER' });
    const barbers = await prisma.barber.findMany({ where: { barbershopId: ind.shopId } });
    expect(barbers).toHaveLength(1);
    expect(barbers[0]).toMatchObject({
      id: ind.barberId,
      userId: ind.userId,
      displayName: 'Carlos',
      isActive: true,
    });
    expect(await rolesOf(ind.userId)).toEqual(['BARBER', 'CLIENT', 'OWNER']);

    const actions = (
      await prisma.auditLog.findMany({ where: { actorId: ind.userId }, orderBy: { id: 'asc' } })
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['barbershop.created', 'barber.self_linked']));
  });

  it('RF-BAR-002: la consulta pública muestra el tipo, y BARBERSHOP es el tipo por defecto', async () => {
    const ind = await independent();
    const pub = await ind.client.get(`${SHOPS}/${ind.shopId}`).expect(200);
    expect(pub.body.type).toBe('INDEPENDENT');
    const team = await ind.client.get(`${SHOPS}/${ind.shopId}/barbers`).expect(200);
    expect(team.body.items).toHaveLength(1);

    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    const shop = await client.get(`${SHOPS}/${owner.shopId}`).expect(200);
    expect(shop.body.type).toBe('BARBERSHOP');
    const mine = await client.get('/api/v1/me/barbershops', owner.token).expect(200);
    expect(mine.body.items[0].type).toBe('BARBERSHOP');
  });

  it('RF-BAR-001: sin displayName usa el nombre de la cuenta (o el del negocio)', async () => {
    const ind = await independent({ displayName: undefined });
    const barber = await prisma.barber.findUniqueOrThrow({ where: { id: ind.barberId } });
    expect(barber.displayName.length).toBeGreaterThan(1);
  });

  it('Carrera del barbero: quien ya es barbero en otra barbería puede pasar a independiente', async () => {
    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    await client.post(`${SHOPS}/${owner.shopId}/barbers/me`, {}, owner.token).expect(201);
    await client.post(INDEPENDENT, shopPayload({ name: 'Mi negocio' }), owner.token).expect(201);
    // Los dos vínculos quedan en el mismo perfil profesional.
    const links = await prisma.barber.findMany({
      where: { userId: owner.userId, deletedAt: null },
    });
    expect(links).toHaveLength(2);
    expect(new Set(links.map((l) => l.barberProfileId)).size).toBe(1);
  });

  it('el barbero independiente puede trabajar además en otra barbería (una vez por barbería)', async () => {
    const ind = await independent();
    const other = await ind.client.post(SHOPS, shopPayload(), ind.token).expect(201);
    await ind.client.post(`${SHOPS}/${other.body.id}/barbers/me`, {}, ind.token).expect(201);
    const again = await ind.client
      .post(`${SHOPS}/${other.body.id}/barbers/me`, {}, ind.token)
      .expect(409);
    expect(again.body.code).toBe('BARBER_ALREADY_ACTIVE_ELSEWHERE');
  });

  it('RF-BRB-001: una barbería INDEPENDENT rechaza un segundo barbero activo', async () => {
    const ind = await independent();
    const res = await ind.client
      .post(`${SHOPS}/${ind.shopId}/barbers`, { displayName: 'Ayudante' }, ind.token)
      .expect(409);
    expect(res.body.code).toBe('INDEPENDENT_SINGLE_BARBER');
    expect(await prisma.barber.count({ where: { barbershopId: ind.shopId } })).toBe(1);
  });

  it('RF-BRB-002: tras desactivar al barbero se admite otro, pero no reactivar al primero', async () => {
    const ind = await independent();
    await ind.client
      .patch(`${SHOPS}/${ind.shopId}/barbers/${ind.barberId}`, { isActive: false }, ind.token)
      .expect(200);
    await ind.client
      .post(`${SHOPS}/${ind.shopId}/barbers`, { displayName: 'Reemplazo' }, ind.token)
      .expect(201);

    const res = await ind.client
      .patch(`${SHOPS}/${ind.shopId}/barbers/${ind.barberId}`, { isActive: true }, ind.token)
      .expect(409);
    expect(res.body.code).toBe('INDEPENDENT_SINGLE_BARBER');
  });

  it('una barbería BARBERSHOP sigue admitiendo varios barberos activos', async () => {
    const client = new AuthClient(app);
    const owner = await ownerWithShop(client);
    for (const displayName of ['Uno', 'Dos']) {
      await client
        .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName }, owner.token)
        .expect(201);
    }
  });

  it('la base rechaza un segundo barbero activo y el cambio de tipo (triggers)', async () => {
    const ind = await independent();
    await expect(
      prisma.barber.create({ data: { barbershopId: ind.shopId, displayName: 'Directo' } }),
    ).rejects.toThrow(/single active barber/);
    await expect(
      prisma.barbershop.update({ where: { id: ind.shopId }, data: { type: 'BARBERSHOP' } }),
    ).rejects.toThrow(/immutable/);
    // Un barbero inactivo sí se puede insertar.
    await prisma.barber.create({
      data: { barbershopId: ind.shopId, displayName: 'Inactivo', isActive: false },
    });
  });

  it('el tipo no se cambia por PATCH (campo desconocido rechazado)', async () => {
    const ind = await independent();
    await ind.client.patch(`${SHOPS}/${ind.shopId}`, { type: 'BARBERSHOP' }, ind.token).expect(400);
  });

  it('valida los datos y exige sesión', async () => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    const bad = await client
      .post(INDEPENDENT, shopPayload({ phone: undefined, displayName: 'x' }), tokens.accessToken)
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    expect(await prisma.barbershopMember.count({ where: { userId: tokens.user.id } })).toBe(0);
    await client.post(INDEPENDENT, shopPayload()).expect(401);
  });
});
