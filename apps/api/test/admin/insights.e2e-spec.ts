import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';
import { staffToken } from '../support/mfa';

/** Gestión de TI del panel: búsqueda global, métricas, salud, auditoría y personal. */
describe('Panel: búsqueda, métricas, salud, auditoría y personal (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  let boss: Person;
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
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    boss = { client, token: tokens.accessToken, userId: tokens.user.id, email };
    await prisma.userRole.create({ data: { userId: boss.userId, role: 'ADMIN' } });
    boss.token = await staffToken(app, boss);
  });
  afterAll(() => app.close());

  it('búsqueda global: cuentas por usuario, nombre o correo; barberías; reserva por código', async () => {
    const shop = await kit.shopReady();
    const visit = await kit.attended(shop, lima(MONDAY, '10:00'));
    const user = await prisma.user.findUniqueOrThrow({ where: { id: visit.person.userId } });
    const byUser = await boss.client
      .get(`${API}/admin/search?q=${user.username}`, boss.token)
      .expect(200);
    expect(byUser.body.users[0]).toMatchObject({
      id: user.id,
      username: user.username,
      email: visit.person.email,
    });
    const byEmail = await boss.client
      .get(`${API}/admin/search?q=${encodeURIComponent(visit.person.email)}`, boss.token)
      .expect(200);
    expect(byEmail.body.users.map((u: { id: string }) => u.id)).toEqual([user.id]);
    const byShop = await boss.client
      .get(`${API}/admin/search?q=Barber%C3%ADa%20E2E`, boss.token)
      .expect(200);
    expect(byShop.body.barbershops.map((b: { id: string }) => b.id)).toContain(shop.shopId);
    const byBooking = await boss.client
      .get(`${API}/admin/search?q=${visit.id}`, boss.token)
      .expect(200);
    expect(byBooking.body.bookings[0]).toMatchObject({
      id: visit.id,
      status: 'ATTENDED',
      serviceName: 'Corte',
    });
    await boss.client.get(`${API}/admin/search?q=a`, boss.token).expect(400);
  });

  it('métricas por día con reservas, cobros, comisión, cuentas y planes', async () => {
    const res = await boss.client.get(`${API}/admin/metrics?days=7`, boss.token).expect(200);
    expect(res.body.series).toHaveLength(7);
    expect(res.body.series[6]).toHaveProperty('date');
    expect(res.body.totalBookings).toBe(
      res.body.series.reduce((s: number, d: { bookings: number }) => s + d.bookings, 0),
    );
    expect(res.body).toHaveProperty('lossRate');
    expect(Array.isArray(res.body.plans)).toBe(true);
    await boss.client.get(`${API}/admin/metrics?days=3`, boss.token).expect(400);
  });

  it('salud: base, Redis, fotos, outbox, avisos, pagos y colas', async () => {
    const res = await boss.client.get(`${API}/admin/system/health`, boss.token).expect(200);
    expect(['OK', 'WARN']).toContain(res.body.status);
    const names = res.body.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['Base de datos', 'Redis (colas y caché)', 'Pagos y reembolsos']),
    );
    const db = res.body.checks.find((c: { name: string }) => c.name === 'Base de datos');
    expect(db.status).not.toBe('DOWN');
    expect(res.body.queues.map((q: { name: string }) => q.name)).toContain('outbox');
  });

  it('auditoría filtrable, paginada y en CSV; personal con segundo factor y actividad', async () => {
    const target = await kit.verified();
    await boss.client
      .post(
        `${API}/admin/users/${target.userId}/disable`,
        { reason: 'Prueba de auditoría' },
        boss.token,
      )
      .expect((r) => expect([200, 201, 204]).toContain(r.status));
    const me = await prisma.user.findUniqueOrThrow({ where: { id: boss.userId } });
    const page = await boss.client
      .get(`${API}/admin/audit?actor=${me.username}&entityType=user&limit=1`, boss.token)
      .expect(200);
    expect(page.body.items[0]).toMatchObject({
      actor: me.username,
      entityType: 'user',
      entityId: target.userId,
    });
    const none = await boss.client
      .get(`${API}/admin/audit?actor=nadie_existe_x`, boss.token)
      .expect(200);
    expect(none.body).toEqual({ items: [], nextCursor: null });
    const ranged = await boss.client
      .get(
        `${API}/admin/audit?action=user&from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`,
        boss.token,
      )
      .expect(200);
    expect(ranged.body.items.length).toBeGreaterThan(0);
    if (page.body.nextCursor) {
      await boss.client
        .get(`${API}/admin/audit?cursor=${page.body.nextCursor}`, boss.token)
        .expect(200);
    }
    const csv = await boss.client
      .get(`${API}/admin/audit.csv?actor=${me.username}`, boss.token)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('fecha,usuario,accion');
    expect(csv.text).toContain(me.username);

    const staff = await boss.client.get(`${API}/admin/staff`, boss.token).expect(200);
    const row = staff.body.find((s: { id: string }) => s.id === boss.userId);
    expect(row).toMatchObject({ roles: ['ADMIN'], mfaEnabled: true, status: 'ACTIVE' });
    expect(row.actionsLast30d).toBeGreaterThan(0);
    expect(row.lastLoginAt).not.toBeNull();
  });
});
