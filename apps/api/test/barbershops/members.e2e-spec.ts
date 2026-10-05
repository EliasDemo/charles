import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import { BlindIndexKind } from '../../src/common/crypto/encryption-contexts';
import { EncryptionService } from '../../src/common/crypto/encryption.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import {
  AuthClient,
  codeFrom,
  createAuthTestApp,
  expireLocks,
  mailsTo,
  uniqueEmail,
  waitForMail,
} from '../support/auth';
import { inviteAndAccept, ownerWithShop } from '../support/barbershops';

const SHOPS = '/api/v1/barbershops';

describe('RF-BAR-001 Varios responsables e invitaciones (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let encryption: EncryptionService;

  beforeAll(async () => {
    app = await createAuthTestApp();
    prisma = app.get(PrismaService);
    encryption = app.get(EncryptionService);
  });
  afterAll(() => app.close());

  async function setup() {
    const ownerClient = new AuthClient(app);
    const owner = await ownerWithShop(ownerClient);
    const inviteeClient = new AuthClient(app);
    const invitee = await inviteeClient.newUser();
    return {
      owner: { ...owner, client: ownerClient },
      invitee: {
        client: inviteeClient,
        email: invitee.email,
        password: invitee.password,
        token: invitee.tokens.accessToken,
        userId: invitee.tokens.user.id,
      },
    };
  }

  const remove = (client: AuthClient, shopId: string, userId: string, token: string) =>
    client.delete(`${SHOPS}/${shopId}/members/${userId}`, token);

  it('RF-BAR-001 invitar responde igual exista o no la cuenta; solo la existente recibe el código', async () => {
    const { owner, invitee } = await setup();
    const path = `${SHOPS}/${owner.shopId}/members/invitations`;
    const missingEmail = uniqueEmail();
    const existing = await owner.client
      .post(path, { email: invitee.email, role: 'MANAGER' }, owner.token)
      .expect(202);
    const missing = await owner.client
      .post(path, { email: missingEmail, role: 'MANAGER' }, owner.token)
      .expect(202);
    expect(missing.body).toEqual(existing.body);
    await waitForMail(app, invitee.email, 'member-invitation');
    expect(await mailsTo(app, missingEmail)).toEqual([]);
  });

  it('RF-BAR-001 aceptar con el código agrega al responsable con su rol y el rol global OWNER', async () => {
    const { owner, invitee } = await setup();
    await inviteAndAccept(app, owner, invitee, 'MANAGER');

    const members = await owner.client
      .get(`${SHOPS}/${owner.shopId}/members`, owner.token)
      .expect(200);
    expect(members.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: owner.userId, role: 'OWNER' }),
        expect.objectContaining({
          userId: invitee.userId,
          role: 'MANAGER',
          fullName: 'Persona de Prueba',
        }),
      ]),
    );
    const relogged = await invitee.client.login(invitee.email, invitee.password).expect(200);
    expect(relogged.body.user.roles).toContain('OWNER');
    expect(
      await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barbershop.member_added', entityId: owner.shopId },
      }),
    ).toMatchObject({
      changes: expect.objectContaining({ values: { role: { from: null, to: 'MANAGER' } } }),
    });
  });

  it('MANAGER: puede editar la barbería, pero no cambiar su estado, invitar ni gestionar responsables', async () => {
    const { owner, invitee } = await setup();
    await inviteAndAccept(app, owner, invitee, 'MANAGER');
    const m = invitee.client;
    await m
      .patch(`${SHOPS}/${owner.shopId}`, { name: 'Editada por manager' }, invitee.token)
      .expect(200);
    await m
      .patch(`${SHOPS}/${owner.shopId}/status`, { status: 'TEMPORARILY_CLOSED' }, invitee.token)
      .expect(403);
    await m
      .post(
        `${SHOPS}/${owner.shopId}/members/invitations`,
        { email: uniqueEmail(), role: 'MANAGER' },
        invitee.token,
      )
      .expect(403);
    await m
      .patch(`${SHOPS}/${owner.shopId}/members/${owner.userId}`, { role: 'MANAGER' }, invitee.token)
      .expect(403);
    await remove(m, owner.shopId, owner.userId, invitee.token).expect(403);
  });

  describe('código de invitación (mismas reglas que la Fase 3)', () => {
    it('es de un solo uso y solo se guarda su HMAC', async () => {
      const { owner, invitee } = await setup();
      await owner.client
        .post(
          `${SHOPS}/${owner.shopId}/members/invitations`,
          { email: invitee.email, role: 'MANAGER' },
          owner.token,
        )
        .expect(202);
      const code = codeFrom(await waitForMail(app, invitee.email, 'member-invitation'));
      const row = await prisma.barbershopInvitation.findFirstOrThrow({
        where: { invitedUserId: invitee.userId },
      });
      expect(row.codeHash).toHaveLength(32);
      expect(Buffer.from(row.codeHash).toString('utf8')).not.toContain(code);

      const accept = `/api/v1/me/barbershop-invitations/${row.id}/accept`;
      await invitee.client.post(accept, { code }, invitee.token).expect(204);
      const again = await invitee.client.post(accept, { code }, invitee.token).expect(400);
      expect(again.body.code).toBe('INVALID_CODE');
    });

    it('se invalida tras 5 intentos fallidos, que cuentan para el bloqueo', async () => {
      const { owner, invitee } = await setup();
      await owner.client
        .post(
          `${SHOPS}/${owner.shopId}/members/invitations`,
          { email: invitee.email, role: 'OWNER' },
          owner.token,
        )
        .expect(202);
      const code = codeFrom(await waitForMail(app, invitee.email, 'member-invitation'));
      const row = await prisma.barbershopInvitation.findFirstOrThrow({
        where: { invitedUserId: invitee.userId },
      });
      const accept = `/api/v1/me/barbershop-invitations/${row.id}/accept`;
      const wrong = ((Number(code) + 1) % 1_000_000).toString().padStart(6, '0');

      for (let i = 0; i < 5; i++)
        await invitee.client.post(accept, { code: wrong }, invitee.token).expect(400);
      // 5 fallos alcanzan el umbral de la cuenta: queda bloqueada.
      await invitee.client.post(accept, { code }, invitee.token).expect(429);
      const ip = app.get<Redis>(REDIS_CLIENT);
      expect(await ip.get(`auth:attempts:ip:${invitee.client.ip}:failures`)).toBe('5');

      await expireLocks(
        app,
        'account',
        encryption.blindIndex(invitee.email, BlindIndexKind.EMAIL).toString('hex'),
      );
      const res = await new AuthClient(app).post(accept, { code }, invitee.token).expect(400);
      expect(res.body.code).toBe('INVALID_CODE');
      const stored = await prisma.barbershopInvitation.findUniqueOrThrow({ where: { id: row.id } });
      expect(stored.attempts).toBe(5);
      expect(stored.acceptedAt).toBeNull();
    });

    it('vence: una invitación vencida no se puede aceptar', async () => {
      const { owner, invitee } = await setup();
      await owner.client
        .post(
          `${SHOPS}/${owner.shopId}/members/invitations`,
          { email: invitee.email, role: 'MANAGER' },
          owner.token,
        )
        .expect(202);
      const code = codeFrom(await waitForMail(app, invitee.email, 'member-invitation'));
      const row = await prisma.barbershopInvitation.findFirstOrThrow({
        where: { invitedUserId: invitee.userId },
      });
      await prisma.barbershopInvitation.update({
        where: { id: row.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await invitee.client
        .post(`/api/v1/me/barbershop-invitations/${row.id}/accept`, { code }, invitee.token)
        .expect(400);
    });

    it('solo el invitado puede aceptar su invitación', async () => {
      const { owner, invitee } = await setup();
      await owner.client
        .post(
          `${SHOPS}/${owner.shopId}/members/invitations`,
          { email: invitee.email, role: 'MANAGER' },
          owner.token,
        )
        .expect(202);
      const code = codeFrom(await waitForMail(app, invitee.email, 'member-invitation'));
      const row = await prisma.barbershopInvitation.findFirstOrThrow({
        where: { invitedUserId: invitee.userId },
      });
      const intruder = new AuthClient(app);
      const { tokens } = await intruder.newUser();
      await intruder
        .post(`/api/v1/me/barbershop-invitations/${row.id}/accept`, { code }, tokens.accessToken)
        .expect(400);
    });
  });

  describe('siempre al menos un OWNER', () => {
    it('el único OWNER no puede retirarse ni degradarse', async () => {
      const client = new AuthClient(app);
      const owner = await ownerWithShop(client);
      const leave = await remove(client, owner.shopId, owner.userId, owner.token).expect(409);
      expect(leave.body.code).toBe('LAST_OWNER');
      const demote = await client
        .patch(`${SHOPS}/${owner.shopId}/members/${owner.userId}`, { role: 'MANAGER' }, owner.token)
        .expect(409);
      expect(demote.body.code).toBe('LAST_OWNER');
    });

    it('con dos OWNER se puede degradar a uno; luego el que queda ya no puede irse', async () => {
      const { owner, invitee } = await setup();
      await inviteAndAccept(app, owner, invitee, 'OWNER');

      await owner.client
        .patch(
          `${SHOPS}/${owner.shopId}/members/${invitee.userId}`,
          { role: 'MANAGER' },
          owner.token,
        )
        .expect(204);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'barbershop.member_role_changed', entityId: owner.shopId },
      });
      expect(audit.changes).toEqual({
        userId: invitee.userId,
        values: { role: { from: 'OWNER', to: 'MANAGER' } },
      });

      await remove(owner.client, owner.shopId, owner.userId, owner.token).expect(409);
    });

    it('dos OWNER quitándose mutuamente a la vez: la barbería conserva exactamente un OWNER', async () => {
      const { owner, invitee } = await setup();
      await inviteAndAccept(app, owner, invitee, 'OWNER');
      const results = await Promise.all([
        remove(owner.client, owner.shopId, invitee.userId, owner.token),
        remove(invitee.client, owner.shopId, owner.userId, invitee.token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
      expect(
        await prisma.barbershopMember.count({
          where: { barbershopId: owner.shopId, role: 'OWNER' },
        }),
      ).toBe(1);
    });

    it('un MANAGER puede retirarse y pierde el rol global OWNER si no administra otra barbería', async () => {
      const { owner, invitee } = await setup();
      await inviteAndAccept(app, owner, invitee, 'MANAGER');
      await remove(invitee.client, owner.shopId, invitee.userId, invitee.token).expect(204);
      const roles = await prisma.userRole.findMany({ where: { userId: invitee.userId } });
      expect(roles.map((r) => r.role)).toEqual(['CLIENT']);
    });

    it('un no miembro no puede ver ni gestionar responsables', async () => {
      const owner = await ownerWithShop(new AuthClient(app));
      const stranger = new AuthClient(app);
      const { tokens } = await stranger.newUser();
      await stranger.get(`${SHOPS}/${owner.shopId}/members`, tokens.accessToken).expect(404);
      await stranger
        .post(
          `${SHOPS}/${owner.shopId}/members/invitations`,
          { email: uniqueEmail(), role: 'OWNER' },
          tokens.accessToken,
        )
        .expect(404);
      await remove(stranger, owner.shopId, owner.userId, tokens.accessToken).expect(404);
    });
  });

  it('invitar a quien ya es responsable no envía nada', async () => {
    const { owner } = await setup();
    await owner.client
      .post(
        `${SHOPS}/${owner.shopId}/members/invitations`,
        { email: owner.email, role: 'OWNER' },
        owner.token,
      )
      .expect(202);
    const mails = await mailsTo(app, owner.email, 800);
    expect(mails.filter((m) => m.category === 'member-invitation')).toEqual([]);
  });
});
