import type { NestExpressApplication } from '@nestjs/platform-express';
import { OutboxRelay } from '../../src/common/outbox/outbox.relay';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { shopPayload } from '../support/barbershops';
import { API, bookingKit, type BookingKit, lima, MONDAY, type Person } from '../support/bookings';

const SHOPS = `${API}/barbershops`;
const DNI = { type: 'DNI', number: '12345678' };
const RUC = { type: 'RUC', number: '20100047218' };

describe('Alta de barberías con revisión previa (e2e)', () => {
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
  afterAll(() => app.close());

  /** charles_test no siembra ajustes: se crean para la prueba y se borran al terminar. */
  async function withSettings(values: Record<string, unknown>, run: () => Promise<void>) {
    const keys = Object.keys(values);
    await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    for (const [key, value] of Object.entries(values)) {
      await prisma.appSetting.create({ data: { key, value: value as never } });
    }
    try {
      await run();
    } finally {
      await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    }
  }

  async function owner(): Promise<Person> {
    const client = new AuthClient(app);
    const { email, tokens } = await client.newUser();
    return { client, token: tokens.accessToken, userId: tokens.user.id, email };
  }

  async function staff(): Promise<Person> {
    const p = await owner();
    await prisma.userRole.create({ data: { userId: p.userId, role: 'SUPPORT' } });
    return p;
  }

  const relayAll = async () => {
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { availableAt: new Date(0) },
    });
    while ((await app.get(OutboxRelay).relayBatch()) > 0);
  };

  const create = (who: Person, extra: Record<string, unknown> = {}) =>
    who.client.post(SHOPS, shopPayload(extra), who.token);

  it('recorrido completo: borrador, envío, cambios pedidos con motivo, reenvío y aprobación', async () => {
    await withSettings({ 'barbershops.require_review': true }, async () => {
      const me = await owner();
      const created = await create(me).expect(201);
      expect(created.body).toMatchObject({ status: 'DRAFT', ownerDocument: null });
      const id = created.body.id as string;

      const review = () => me.client.get(`${SHOPS}/${id}/review`, me.token).expect(200);
      expect((await review()).body).toEqual({
        status: 'DRAFT',
        missingRequirements: ['OWNER_DOCUMENT'],
        canSubmit: false,
        reviewNotes: null,
        submittedAt: null,
        submissions: [],
      });
      const missing = await me.client
        .post(`${SHOPS}/${id}/review/submit`, {}, me.token)
        .expect(409);
      expect(missing.body).toMatchObject({
        code: 'REVIEW_REQUIREMENTS_MISSING',
        details: [{ requirement: 'OWNER_DOCUMENT' }],
      });

      // Documento: RUC con dígito verificador inválido → 400; válido → guardado cifrado.
      await me.client
        .put(`${SHOPS}/${id}/owner-document`, { type: 'RUC', number: '20100047219' }, me.token)
        .expect(400);
      const withDoc = await me.client
        .put(`${SHOPS}/${id}/owner-document`, RUC, me.token)
        .expect(200);
      expect(withDoc.body.ownerDocument).toEqual({ type: 'RUC', masked: '********218' });
      const row = await prisma.barbershop.findUniqueOrThrow({ where: { id } });
      expect(row.ownerDocumentEnc).not.toContain('20100047218');
      expect(row.status).toBe('DRAFT');

      const submitted = await me.client
        .post(`${SHOPS}/${id}/review/submit`, {}, me.token)
        .expect(200);
      expect(submitted.body).toMatchObject({ status: 'PENDING_REVIEW', canSubmit: false });
      await me.client.post(`${SHOPS}/${id}/review/submit`, {}, me.token).expect(409);

      // No visible mientras no se aprueba.
      const visitor = new AuthClient(app);
      await visitor.get(`${SHOPS}/${id}`).expect(404);
      await visitor.get(`${SHOPS}/${id}/barbers`).expect(404);

      // Soporte pide cambios con motivo.
      const agent = await staff();
      await agent.client.post(`${API}/admin/barbershops/${id}/reject`, {}, agent.token).expect(400);
      const rejected = await agent.client
        .post(
          `${API}/admin/barbershops/${id}/reject`,
          { reason: 'La dirección no coincide' },
          agent.token,
        )
        .expect(200);
      expect(rejected.body).toMatchObject({
        status: 'CHANGES_REQUESTED',
        reviewNotes: 'La dirección no coincide',
      });
      expect((await review()).body).toMatchObject({
        status: 'CHANGES_REQUESTED',
        canSubmit: true,
        reviewNotes: 'La dirección no coincide',
        submissions: [{ decision: 'CHANGES_REQUESTED', reason: 'La dirección no coincide' }],
      });
      await visitor.get(`${SHOPS}/${id}`).expect(404);
      await relayAll();
      const changes = await prisma.notification.findMany({
        where: { userId: me.userId, type: 'BARBERSHOP_CHANGES_REQUESTED' },
      });
      expect(changes.map((n) => n.channel).sort()).toEqual(['EMAIL', 'IN_APP', 'PUSH']);
      expect(changes.find((n) => n.channel === 'PUSH')!.body).not.toContain('dirección');
      expect(changes.find((n) => n.channel === 'IN_APP')!.body).toContain(
        'La dirección no coincide',
      );

      // Corrige, reenvía y soporte aprueba.
      await me.client
        .patch(`${SHOPS}/${id}`, { address: 'Av. Correcta 1, Lima' }, me.token)
        .expect(200);
      await me.client.post(`${SHOPS}/${id}/review/submit`, {}, me.token).expect(200);
      await agent.client
        .post(
          `${API}/admin/barbershops/${id}/approve`,
          { reason: 'Datos verificados' },
          agent.token,
        )
        .expect(200);
      expect((await review()).body).toMatchObject({
        status: 'OPEN',
        reviewNotes: null,
        submittedAt: null,
        submissions: [{ decision: 'APPROVED' }, { decision: 'CHANGES_REQUESTED' }],
      });
      await visitor.get(`${SHOPS}/${id}`).expect(200);
      await relayAll();
      expect(
        await prisma.notification.count({
          where: { userId: me.userId, type: 'BARBERSHOP_APPROVED' },
        }),
      ).toBe(3);
    });
  });

  it('con el documento en el alta va directo a revisión; también el barbero independiente', async () => {
    await withSettings({ 'barbershops.require_review': true }, async () => {
      const me = await owner();
      expect((await create(me, { ownerDocument: DNI }).expect(201)).body.status).toBe(
        'PENDING_REVIEW',
      );
      const independent = await owner();
      const res = await independent.client
        .post(`${SHOPS}/independent`, { ...shopPayload(), ownerDocument: DNI }, independent.token)
        .expect(201);
      expect(res.body.status).toBe('PENDING_REVIEW');
      const draft = await owner();
      const res2 = await draft.client
        .post(`${SHOPS}/independent`, shopPayload(), draft.token)
        .expect(201);
      expect(res2.body.status).toBe('DRAFT');
      expect(
        await prisma.barbershopReviewSubmission.count({ where: { barbershopId: res.body.id } }),
      ).toBe(1);
    });
  });

  it('sin revisión previa (ajuste apagado) se publica al instante, con o sin documento', async () => {
    const me = await owner();
    expect((await create(me).expect(201)).body.status).toBe('OPEN');
  });

  it('la foto se exige solo si barbershops.require_photo está activo', async () => {
    await withSettings(
      { 'barbershops.require_review': true, 'barbershops.require_photo': true },
      async () => {
        const me = await owner();
        const created = await create(me, { ownerDocument: DNI }).expect(201);
        expect(created.body.status).toBe('DRAFT');
        const review = await me.client
          .get(`${SHOPS}/${created.body.id}/review`, me.token)
          .expect(200);
        expect(review.body).toMatchObject({ missingRequirements: ['PHOTO'], canSubmit: false });
      },
    );
  });

  it('el documento: solo el OWNER lo ve enmascarado; soporte completo con motivo y auditoría', async () => {
    const me = await owner();
    const id = (await create(me, { ownerDocument: RUC }).expect(201)).body.id as string;
    const manager = await owner();
    await prisma.barbershopMember.create({
      data: { barbershopId: id, userId: manager.userId, role: 'MANAGER' },
    });
    const asManager = await manager.client
      .get(`${API}/me/barbershops/${id}`, manager.token)
      .expect(200);
    expect(asManager.body.ownerDocument).toBeNull();
    await manager.client.put(`${SHOPS}/${id}/owner-document`, DNI, manager.token).expect(403);
    await manager.client.post(`${SHOPS}/${id}/review/submit`, {}, manager.token).expect(403);

    const agent = await staff();
    await agent.client
      .post(`${API}/admin/barbershops/${id}/owner-document`, {}, agent.token)
      .expect(400);
    const doc = await agent.client
      .post(
        `${API}/admin/barbershops/${id}/owner-document`,
        { reason: 'Verificar identidad' },
        agent.token,
      )
      .expect(200);
    expect(doc.body).toEqual({ type: 'RUC', number: '20100047218' });
    expect(doc.headers['cache-control']).toBe('no-store');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'barbershop.owner_document_viewed', entityId: id },
    });
    expect(audit.changes).toEqual({ reason: 'Verificar identidad', actorRole: 'SUPPORT' });
    // Conflicto de interés: un miembro de la barbería no lo ve.
    await prisma.userRole.create({ data: { userId: manager.userId, role: 'SUPPORT' } });
    await manager.client
      .post(`${API}/admin/barbershops/${id}/owner-document`, { reason: 'Es mía' }, manager.token)
      .expect(403);
    const setAudit = await prisma.auditLog.findMany({
      where: { entityId: id, action: { startsWith: 'barbershop.' } },
    });
    expect(JSON.stringify(setAudit.map((a) => a.changes))).not.toContain('20100047218');
  });

  it('una barbería aprobada que cambia su documento sigue visible y queda marcada; la cola se ordena por espera', async () => {
    const me = await owner();
    const id = (await create(me, { ownerDocument: DNI }).expect(201)).body.id as string;
    await me.client.put(`${SHOPS}/${id}/owner-document`, DNI, me.token).expect(200);
    expect((await prisma.barbershop.findUniqueOrThrow({ where: { id } })).flaggedReason).toBeNull();
    await me.client.put(`${SHOPS}/${id}/owner-document`, RUC, me.token).expect(200);
    const row = await prisma.barbershop.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.flaggedReason]).toEqual(['OPEN', 'owner_document_changed']);
    await new AuthClient(app).get(`${SHOPS}/${id}`).expect(200);

    const agent = await staff();
    const all: { id: string; waitingSince: string }[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { items: typeof all; nextCursor: string | null } } = await agent.client
        .get(`${API}/admin/barbershops?limit=5${cursor ? `&cursor=${cursor}` : ''}`, agent.token)
        .expect(200);
      all.push(...page.body.items);
      cursor = page.body.nextCursor;
    } while (cursor);
    const flagged = all.find((s) => s.id === id);
    expect(flagged).toMatchObject({
      flaggedReason: 'owner_document_changed',
      ownerDocumentType: 'RUC',
    });
    const times = all.map((s) => new Date(s.waitingSince).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    await agent.client.get(`${API}/admin/barbershops?cursor=no-valido`, agent.token).expect(400);
  });

  it('las reservas traen service.categoryKey (detalle, listas y agenda)', async () => {
    const shop = await kit.shopReady();
    const booking = await kit.book(shop, lima(MONDAY, '12:00'));
    const detail = await booking.person.client
      .get(`${API}/bookings/${booking.id}`, booking.person.token)
      .expect(200);
    expect(detail.body.service).toEqual({
      id: shop.serviceId,
      name: 'Corte',
      categoryKey: 'haircut',
    });
    const mine = await booking.person.client
      .get(`${API}/me/bookings`, booking.person.token)
      .expect(200);
    expect(mine.body.items[0].service.categoryKey).toBe('haircut');
    const agenda = await shop.owner.client
      .get(`${SHOPS}/${shop.shopId}/agenda?date=${MONDAY}`, shop.owner.token)
      .expect(200);
    expect(agenda.body.items[0].service.categoryKey).toBe('haircut');
  });
});
