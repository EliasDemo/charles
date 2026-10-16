import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, codeFrom, createAuthTestApp, waitForMail } from '../support/auth';
import { inviteAndAccept, ownerWithShop, shopPayload } from '../support/barbershops';

const SHOPS = '/api/v1/barbershops';

describe('Roles globales derivados: OWNER y BARBER (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  const rolesOf = async (userId: string): Promise<string[]> =>
    (await prisma.userRole.findMany({ where: { userId } })).map((r) => r.role).sort();

  /** Barbero con cuenta vinculada por invitación. */
  async function linkedBarber() {
    const ownerClient = new AuthClient(app);
    const owner = await ownerWithShop(ownerClient);
    const barber = await ownerClient
      .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName: 'Pedro' }, owner.token)
      .expect(201);
    const accountClient = new AuthClient(app);
    const account = await accountClient.newUser();
    await ownerClient
      .post(
        `${SHOPS}/${owner.shopId}/barbers/${barber.body.id}/invitations`,
        { email: account.email },
        owner.token,
      )
      .expect(202);
    const code = codeFrom(await waitForMail(app, account.email, 'barber-invitation'));
    const list = await accountClient
      .get('/api/v1/me/barbershop-invitations', account.tokens.accessToken)
      .expect(200);
    await accountClient
      .post(
        `/api/v1/me/barbershop-invitations/${list.body.items[0].id}/accept`,
        { code },
        account.tokens.accessToken,
      )
      .expect(204);
    return {
      owner: { ...owner, client: ownerClient },
      barberId: barber.body.id as string,
      account: { ...account, client: accountClient, userId: account.tokens.user.id },
    };
  }

  describe('OWNER: se pierde al dejar de ser miembro de todas sus barberías', () => {
    it('al eliminar su única barbería pierde OWNER, y el token renovado ya no lo incluye', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const session = (await client.login(owner.email, owner.password).expect(200)).body;
      expect(session.user.roles).toContain('OWNER');

      await client.delete(`${SHOPS}/${owner.shopId}`, owner.token).expect(204);
      expect(await rolesOf(owner.userId)).toEqual(['CLIENT']);

      const refreshed = await client
        .post('/api/v1/auth/refresh', { refreshToken: session.refreshToken })
        .expect(200);
      expect(refreshed.body.user.roles).toEqual(['CLIENT']);
    });

    it('si aún administra otra barbería, conserva OWNER', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      await client.post(SHOPS, shopPayload({ name: 'Sede 2' }), owner.token).expect(201);
      await client.delete(`${SHOPS}/${owner.shopId}`, owner.token).expect(204);
      expect(await rolesOf(owner.userId)).toEqual(['CLIENT', 'OWNER']);
    });

    it('un MANAGER pierde OWNER al eliminarse la barbería que administraba', async () => {
      const ownerClient = new AuthClient(app);
      const owner = await ownerWithShop(ownerClient);
      const managerClient = new AuthClient(app);
      const manager = await managerClient.newUser();
      await inviteAndAccept(
        app,
        { client: ownerClient, token: owner.token, shopId: owner.shopId },
        { client: managerClient, email: manager.email, token: manager.tokens.accessToken },
        'MANAGER',
      );
      expect(await rolesOf(manager.tokens.user.id)).toEqual(['CLIENT', 'OWNER']);

      await ownerClient.delete(`${SHOPS}/${owner.shopId}`, owner.token).expect(204);
      expect(await rolesOf(manager.tokens.user.id)).toEqual(['CLIENT']);
    });

    it('un MANAGER que se retira pierde OWNER', async () => {
      const ownerClient = new AuthClient(app);
      const owner = await ownerWithShop(ownerClient);
      const managerClient = new AuthClient(app);
      const manager = await managerClient.newUser();
      await inviteAndAccept(
        app,
        { client: ownerClient, token: owner.token, shopId: owner.shopId },
        { client: managerClient, email: manager.email, token: manager.tokens.accessToken },
        'MANAGER',
      );
      await managerClient
        .delete(
          `${SHOPS}/${owner.shopId}/members/${manager.tokens.user.id}`,
          manager.tokens.accessToken,
        )
        .expect(204);
      expect(await rolesOf(manager.tokens.user.id)).toEqual(['CLIENT']);
    });
  });

  // Carrera del barbero: el rol BARBER sigue mientras exista su perfil profesional (sigue siendo
  // barbero: puede postular a empleos), aunque deje de estar activo en una barbería.
  describe('BARBER: depende de su perfil profesional, no de una barbería', () => {
    it('al desactivarlo conserva BARBER por su perfil; sin perfil, lo pierde', async () => {
      const { owner, barberId, account } = await linkedBarber();
      expect(await rolesOf(account.userId)).toEqual(['BARBER', 'CLIENT']);
      expect(await prisma.barberProfile.count({ where: { userId: account.userId } })).toBe(1);

      await owner.client
        .patch(`${SHOPS}/${owner.shopId}/barbers/${barberId}`, { isActive: false }, owner.token)
        .expect(200);
      expect(await rolesOf(account.userId)).toEqual(['BARBER', 'CLIENT']);

      // Sin perfil profesional (por ejemplo, eliminado) y sin vínculo activo, ya no es BARBER.
      await prisma.barberProfile.update({
        where: { userId: account.userId },
        data: { deletedAt: new Date() },
      });
      for (const isActive of [true, false]) {
        await owner.client
          .patch(`${SHOPS}/${owner.shopId}/barbers/${barberId}`, { isActive }, owner.token)
          .expect(200);
      }
      expect(await rolesOf(account.userId)).toEqual(['CLIENT']);
      const relogged = await account.client.login(account.email, account.password).expect(200);
      expect(relogged.body.user.roles).toEqual(['CLIENT']);

      await owner.client
        .patch(`${SHOPS}/${owner.shopId}/barbers/${barberId}`, { isActive: true }, owner.token)
        .expect(200);
      expect(await rolesOf(account.userId)).toEqual(['BARBER', 'CLIENT']);
    });

    it('al eliminarse la barbería conserva BARBER (su perfil) y puede ser barbero en otra', async () => {
      const { owner, account } = await linkedBarber();
      await owner.client.delete(`${SHOPS}/${owner.shopId}`, owner.token).expect(204);
      expect(await rolesOf(account.userId)).toEqual(['BARBER', 'CLIENT']);

      // Ya no está activo en ninguna barbería: puede registrarse como barbero en la suya.
      const own = await account.client
        .post(SHOPS, shopPayload(), account.tokens.accessToken)
        .expect(201);
      await account.client
        .post(`${SHOPS}/${own.body.id}/barbers/me`, {}, account.tokens.accessToken)
        .expect(201);
      expect(await rolesOf(account.userId)).toEqual(['BARBER', 'CLIENT', 'OWNER']);
    });

    it('el responsable que se desactiva como barbero conserva BARBER (su perfil) y OWNER', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const me = await client
        .post(`${SHOPS}/${owner.shopId}/barbers/me`, {}, owner.token)
        .expect(201);
      expect(await rolesOf(owner.userId)).toEqual(['BARBER', 'CLIENT', 'OWNER']);

      await client
        .patch(`${SHOPS}/${owner.shopId}/barbers/${me.body.id}`, { isActive: false }, owner.token)
        .expect(200);
      expect(await rolesOf(owner.userId)).toEqual(['BARBER', 'CLIENT', 'OWNER']);
    });

    it('desactivar un barbero sin cuenta vinculada no toca roles de nadie', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const barber = await client
        .post(`${SHOPS}/${owner.shopId}/barbers`, { displayName: 'Sin cuenta' }, owner.token)
        .expect(201);
      await client
        .patch(
          `${SHOPS}/${owner.shopId}/barbers/${barber.body.id}`,
          { isActive: false },
          owner.token,
        )
        .expect(200);
      expect(await rolesOf(owner.userId)).toEqual(['CLIENT', 'OWNER']);
    });
  });
});
