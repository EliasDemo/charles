import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AccountDeletionService } from '../../src/modules/account/account-deletion.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { REVIEW_RATE_LIMIT } from '../../src/modules/reviews/review-rate-limit';
import { UsersService } from '../../src/modules/users/users.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import {
  API,
  bookingKit,
  type BookingKit,
  HOUR,
  lima,
  MONDAY,
  type Person,
} from '../support/bookings';

const DAY = 24 * HOUR;
const WEDNESDAY = '2030-01-09';
const DELETION = `${API}/me/account/deletion`;

describe('Eliminación de cuenta (Apple y Google) (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  let deletion: AccountDeletionService;
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
    deletion = app.get(AccountDeletionService);
  });
  beforeEach(() => {
    clock.current = lima(MONDAY, '08:00');
    REVIEW_RATE_LIMIT.set(1000);
  });
  afterAll(() => app.close());

  const relayAll = async () => {
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { availableAt: new Date(0) },
    });
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
  };

  const requestDeletion = (who: { client: AuthClient; token: string }, password: string) =>
    who.client.post(DELETION, { password }, who.token);

  /** Contraseña con la que kit.verified registra (newUser la devuelve; la recuperamos así). */
  async function withPassword(overrides: Record<string, unknown> = {}, ip?: string) {
    const c = new AuthClient(app, ip);
    const { email, password, tokens } = await c.newUser(overrides);
    await prisma.user.update({
      where: { id: tokens.user.id },
      data: { emailVerifiedAt: new Date() },
    });
    const person: Person = { client: c, token: tokens.accessToken, userId: tokens.user.id, email };
    return { person, password };
  }

  describe('solicitud', () => {
    it('vista previa: reservas a cancelar con la misma devolución que la vista previa de cancelación', async () => {
      const shop = await kit.shopReady([1, 3]);
      const { person } = await withPassword();
      const confirmed = await kit.confirmed(shop, lima(WEDNESDAY, '12:00'), person);
      const pending = await kit.book(shop, lima(MONDAY, '15:00'), person);
      const preview = await person.client.get(`${DELETION}/preview`, person.token).expect(200);
      expect(preview.body).toMatchObject({
        canRequest: true,
        blockers: [],
        graceDays: 30,
        pending: false,
      });
      const byId = new Map(
        preview.body.bookings.map((b: { bookingId: string }) => [b.bookingId, b]),
      );
      expect([...byId.keys()].sort()).toEqual([confirmed.id, pending.id].sort());
      const single = await person.client
        .get(`${API}/bookings/${confirmed.id}/cancellation-preview`, person.token)
        .expect(200);
      expect((byId.get(confirmed.id) as { refund: unknown }).refund).toEqual(single.body.refund);
      expect(
        (byId.get(confirmed.id) as { barbershop: { timezone: string } }).barbershop.timezone,
      ).toBe('America/Lima');
    });

    it('bloqueos: único OWNER (409 con detalle) y cuentas de soporte o ADMIN', async () => {
      const shop = await kit.shopReady();
      const ownerRow = await prisma.user.findUniqueOrThrow({ where: { id: shop.owner.userId } });
      expect(ownerRow).toBeTruthy();
      const preview = await shop.owner.client
        .get(`${DELETION}/preview`, shop.owner.token)
        .expect(200);
      expect(preview.body.canRequest).toBe(false);
      expect(preview.body.blockers).toEqual([
        { reason: 'SOLE_OWNER', barbershopId: shop.shopId, barbershopName: 'Barbería E2E' },
      ]);

      const { person, password } = await withPassword();
      await prisma.userRole.create({ data: { userId: person.userId, role: 'SUPPORT' } });
      const blocked = await requestDeletion(person, password).expect(409);
      expect(blocked.body.code).toBe('DELETION_BLOCKED');
      expect(blocked.body.details).toEqual([
        { reason: 'STAFF_ROLE', barbershopId: null, barbershopName: null },
      ]);
    });

    it('contraseña incorrecta: 401 y nada cambia', async () => {
      const { person } = await withPassword();
      await requestDeletion(person, 'incorrecta-123').expect(401);
      const status = await person.client.get(DELETION, person.token).expect(200);
      expect(status.body).toEqual({ pending: false, requestedAt: null, scheduledFor: null });
    });

    it('al confirmar: cancela sus reservas como cliente, cierra tickets y sesiones; solo queda el acceso limitado', async () => {
      const shop = await kit.shopReady([1, 3]);
      const { person, password } = await withPassword();
      const booking = await kit.confirmed(shop, lima(WEDNESDAY, '12:00'), person);
      const ticket = await person.client
        .post(
          `${API}/support/tickets`,
          { category: 'OTHER', subject: 'Consulta', message: 'Hola' },
          person.token,
        )
        .expect(201);

      const res = await requestDeletion(person, password).expect(200);
      expect(res.body).toEqual({
        pending: true,
        requestedAt: new Date(clock.current).toISOString(),
        scheduledFor: new Date(clock.current + 30 * DAY).toISOString(),
      });
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({
        status: 'CANCELLED',
        cancelledByRole: 'CLIENT',
      });
      // Devolución total: con 5 h o más de anticipación (política del cliente).
      expect(
        await prisma.refund.findFirstOrThrow({ where: { paymentId: booking.paymentId } }),
      ).toMatchObject({
        amount: 2500,
        reasonType: 'CLIENT_CANCELLATION',
      });
      expect(
        (await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.body.id } })).status,
      ).toBe('CLOSED');
      await person.client.get(`${API}/users/me`, person.token).expect(401);

      // Iniciar sesión: solo el acceso limitado, con alcance "deletion".
      const user = await prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
      expect(user.deletionScheduledFor).not.toBeNull();
      const login = await person.client.login(person.email, password).expect(403);
      expect(login.body.code).toBe('ACCOUNT_PENDING_DELETION');
      const access = await person.client
        .post(`${API}/auth/support-access`, { email: person.email, password })
        .expect(200);
      expect(access.body.scope).toBe('deletion');
      const limited = access.body.accessToken as string;
      await person.client.get(DELETION, limited).expect(200);
      for (const path of [
        '/users/me',
        '/me/bookings',
        '/me/support/tickets',
        '/me/account/deletion/preview',
      ]) {
        const denied = await person.client.get(`${API}${path}`, limited).expect(403);
        expect(denied.body.code).toBe('ACCOUNT_PENDING_DELETION');
      }
      await requestDeletion({ client: person.client, token: limited }, password).expect(403);

      await relayAll();
      expect(
        await prisma.notification.count({
          where: { userId: person.userId, type: 'ACCOUNT_DELETION_REQUESTED', channel: 'EMAIL' },
        }),
      ).toBe(1);

      // Cancelar: vuelve a iniciar sesión; la reserva no se restaura.
      const cancelled = await person.client.delete(DELETION, limited).expect(200);
      expect(cancelled.body.pending).toBe(false);
      await person.client.delete(DELETION, limited).expect(409);
      await person.client.login(person.email, password).expect(200);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        'CANCELLED',
      );
      await relayAll();
      expect(
        await prisma.notification.count({
          where: { userId: person.userId, type: 'ACCOUNT_DELETION_CANCELLED' },
        }),
      ).toBe(1);
      // Cancelada, el trabajo no la ejecuta aunque pase la fecha.
      clock.current += 31 * DAY;
      await deletion.executeDue();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: person.userId } })).anonymizedAt,
      ).toBeNull();
    });

    it('recordatorio 3 días antes, una sola vez', async () => {
      const { person, password } = await withPassword();
      await requestDeletion(person, password).expect(200);
      clock.current += 26 * DAY;
      await deletion.sendReminders();
      await relayAll();
      expect(
        await prisma.notification.count({
          where: { userId: person.userId, type: 'ACCOUNT_DELETION_REMINDER' },
        }),
      ).toBe(0);
      clock.current += DAY + 1;
      await deletion.sendReminders();
      await deletion.sendReminders();
      await relayAll();
      expect(
        await prisma.notification.count({
          where: { userId: person.userId, type: 'ACCOUNT_DELETION_REMINDER' },
        }),
      ).toBe(1);
    });
  });

  describe('ejecución', () => {
    it('no queda ningún dato personal en ninguna tabla; se conservan pagos, reservas, auditoría y la puntuación', async () => {
      const tag = randomBytes(6).toString('hex');
      const fullName = `Zoila Única ${tag}`;
      const phone = `+51 9${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
      const phoneDigits = phone.replace(/\D/g, '');
      // IP propia (TEST-NET-3, que ninguna otra prueba usa): así se rastrea sin falsos positivos.
      const uniqueIp = `203.0.113.${1 + (randomBytes(1)[0]! % 254)}`;
      const { person, password } = await withPassword({ fullName, phone }, uniqueIp);
      const shop = await kit.shopReady([1, 3]);

      // Datos de la cuenta repartidos por el sistema.
      const attended = await kit.attended(shop, lima(MONDAY, '10:00'), person);
      const commentText = `Comentario privado ${tag}`;
      const review = await person.client
        .post(
          `${API}/bookings/${attended.id}/review`,
          { rating: 4, comment: commentText },
          person.token,
        )
        .expect(201);
      clock.current = lima(MONDAY, '11:00');
      const reasonText = `Motivo personal ${tag}`;
      const cancelledByMe = await kit.confirmed(shop, lima(WEDNESDAY, '12:00'), person);
      await person.client
        .post(`${API}/bookings/${cancelledByMe.id}/cancel`, { reason: reasonText }, person.token)
        .expect(200);
      const future = await kit.confirmed(shop, lima(WEDNESDAY, '15:00'), person);
      const subjectText = `Asunto ${tag}`;
      await person.client
        .post(
          `${API}/support/tickets`,
          { category: 'OTHER', subject: subjectText, message: `Mensaje ${tag}` },
          person.token,
        )
        .expect(201);
      const other = await kit.verified();
      const otherBooking = await kit.attended(shop, lima(MONDAY, '13:00'), other);
      const otherReview = await other.client
        .post(`${API}/bookings/${otherBooking.id}/review`, { rating: 5 }, other.token)
        .expect(201);
      clock.current = lima(MONDAY, '12:00');
      await person.client
        .post(
          `${API}/reviews/${otherReview.body.id}/reports`,
          { reason: 'OTHER', details: `Detalle ${tag}` },
          person.token,
        )
        .expect(204);
      const otherShop = await kit.shopReady();
      await person.client
        .post(
          `${API}/barbershops/${otherShop.shopId}/reports`,
          { reason: 'OTHER', details: `Reporte ${tag}` },
          person.token,
        )
        .expect(204);
      await person.client.put(`${API}/me/favorites/${shop.shopId}`, {}, person.token).expect(204);
      await person.client
        .put(
          `${API}/me/devices`,
          { pushToken: `ExponentPushToken[${tag}abcdefghij]`, platform: 'ANDROID' },
          person.token,
        )
        .expect(200);
      await relayAll();
      await app.get(NotificationsService).deliverDue();

      const before = await prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
      const emailHash = Buffer.from(before.emailHash);
      const phoneHash = Buffer.from(before.phoneHash!);
      const ip = person.client.ip;

      await requestDeletion(person, password).expect(200);
      await relayAll();
      clock.current += 30 * DAY;
      expect(await deletion.executeDue()).toBeGreaterThanOrEqual(1);
      await relayAll();

      // 1. La fila del usuario.
      const after = await prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
      expect(after).toMatchObject({
        fullName: 'Cuenta eliminada',
        phoneEnc: null,
        phoneHash: null,
        documentNumberEnc: null,
        birthDateEnc: null,
        status: 'DISABLED',
        preferences: {},
        metadata: {},
      });
      expect(after.anonymizedAt).not.toBeNull();
      expect(await app.get(UsersService).contactEmail(person.userId)).toBeNull();

      // 2. Recorrido de TODAS las tablas: ningún texto, JSON ni bytea con sus datos.
      const needles = [person.email, fullName, tag, phoneDigits, ip];
      const columns = await prisma.$queryRaw<
        { table_name: string; column_name: string; data_type: string }[]
      >`
        SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
           AND data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'bytea', 'inet')`;
      expect(columns.length).toBeGreaterThan(50);
      const leaks: string[] = [];
      for (const { table_name: table, column_name: column, data_type: type } of columns) {
        if (type === 'bytea') {
          const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" IN ($1, $2)`,
            emailHash,
            phoneHash,
          );
          if (rows[0]!.n > 0) leaks.push(`${table}.${column} (hash)`);
          continue;
        }
        for (const needle of needles) {
          const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}"::text ILIKE $1`,
            `%${needle}%`,
          );
          if (rows[0]!.n > 0) leaks.push(`${table}.${column} contiene «${needle}»`);
        }
      }
      expect(leaks).toEqual([]);

      // 3. Borrado lo que no se conserva.
      expect(await prisma.deviceToken.count({ where: { userId: person.userId } })).toBe(0);
      expect(await prisma.favorite.count({ where: { clientId: person.userId } })).toBe(0);
      expect(await prisma.notification.count({ where: { userId: person.userId } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: person.userId } })).toBe(0);
      expect(await prisma.userRole.count({ where: { userId: person.userId } })).toBe(0);
      const tickets = await prisma.supportTicket.findMany({ where: { userId: person.userId } });
      expect(
        await prisma.ticketMessage.count({ where: { ticketId: { in: tickets.map((t) => t.id) } } }),
      ).toBe(0);

      // 4. Conservado y anonimizado.
      const keptReview = await prisma.review.findUniqueOrThrow({ where: { id: review.body.id } });
      expect([keptReview.rating, keptReview.comment, keptReview.status]).toEqual([
        4,
        null,
        'VISIBLE',
      ]);
      const publicList = await new AuthClient(app)
        .get(`${API}/barbershops/${shop.shopId}/reviews`)
        .expect(200);
      expect(
        publicList.body.items.find((r: { id: string }) => r.id === review.body.id).authorName,
      ).toBe('Cuenta eliminada');
      expect(
        await prisma.payment.count({ where: { booking: { clientId: person.userId } } }),
      ).toBeGreaterThanOrEqual(3);
      expect(await prisma.booking.count({ where: { clientId: person.userId } })).toBe(3);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: future.id } })).status).toBe(
        'CANCELLED',
      );
      expect(await prisma.auditLog.count({ where: { actorId: person.userId } })).toBeGreaterThan(0);
      expect(
        await prisma.auditLog.count({
          where: { action: 'account.deleted', entityId: person.userId },
        }),
      ).toBe(1);

      // 5. La cuenta eliminada ya no entra ni pide acceso limitado.
      await new AuthClient(app).login(person.email, password).expect(401);
      await new AuthClient(app)
        .post(`${API}/auth/support-access`, { email: person.email, password })
        .expect(401);

      // 6. El correo puede registrarse de nuevo (no estaba deshabilitada por soporte).
      const again = new AuthClient(app);
      await again.register({ email: person.email, password }).expect(202);
      expect(await app.get(UsersService).findIdByEmailHash(emailHash)).not.toBeNull();
      expect(await prisma.emailBlocklist.count({ where: { emailHash } })).toBe(0);
    });

    it('audit_log sigue siendo de solo inserción: solo se acepta borrar la IP', async () => {
      const { person } = await withPassword();
      const row = await prisma.auditLog.findFirstOrThrow({
        where: { actorId: person.userId, ip: { not: null } },
      });
      const attempt = (sql: string) =>
        prisma.$executeRawUnsafe(sql, row.id).then(
          () => 'ok',
          (e: unknown) => String((e as Error).message),
        );
      expect(await attempt(`UPDATE audit_log SET action = 'otra' WHERE id = $1::uuid`)).toMatch(
        /solo inserción/,
      );
      expect(
        await attempt(`UPDATE audit_log SET ip = NULL, action = 'otra' WHERE id = $1::uuid`),
      ).toMatch(/solo inserción/);
      expect(await attempt(`UPDATE audit_log SET ip = '10.0.0.1' WHERE id = $1::uuid`)).toMatch(
        /solo inserción/,
      );
      expect(await attempt(`DELETE FROM audit_log WHERE id = $1::uuid`)).toMatch(/solo inserción/);
      expect(await attempt(`UPDATE audit_log SET ip = NULL WHERE id = $1::uuid`)).toBe('ok');
      const after = await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect({ ...after, ip: row.ip }).toEqual(row);
    });

    it('cuenta deshabilitada por soporte: la pide desde el acceso limitado y su correo queda bloqueado 12 meses', async () => {
      const { person, password } = await withPassword();
      await prisma.user.update({ where: { id: person.userId }, data: { status: 'DISABLED' } });
      const access = await person.client
        .post(`${API}/auth/support-access`, { email: person.email, password })
        .expect(200);
      expect(access.body.scope).toBe('support');
      const limited = { client: person.client, token: access.body.accessToken as string };
      await person.client.get(`${DELETION}/preview`, limited.token).expect(200);
      await requestDeletion(limited, password).expect(200);
      const emailHash = Buffer.from(
        (await prisma.user.findUniqueOrThrow({ where: { id: person.userId } })).emailHash,
      );

      clock.current += 30 * DAY;
      await deletion.executeDue();
      const block = await prisma.emailBlocklist.findUniqueOrThrow({ where: { emailHash } });
      expect(block.blockedUntil.getTime()).toBe(clock.current + 365 * DAY);
      expect(Object.keys(block).sort()).toEqual([
        'blockedUntil',
        'createdAt',
        'emailHash',
        'id',
        'updatedAt',
      ]);

      // Registrar ese correo: respuesta idéntica (202) pero no se crea la cuenta.
      await new AuthClient(app).register({ email: person.email, password }).expect(202);
      expect(await app.get(UsersService).findIdByEmailHash(emailHash)).toBeNull();
    });
  });
});
