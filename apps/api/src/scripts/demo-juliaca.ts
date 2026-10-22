import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BlindIndexKind, EncryptedField } from '../common/crypto/encryption-contexts';
import { EncryptionService } from '../common/crypto/encryption.service';
import { PasswordHasher } from '../common/crypto/password-hasher';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import type { FaceShape } from '../generated/prisma/enums';
import { ImagesService } from '../modules/images/images.service';
import { RatingsVerifier } from '../modules/reviews/review-ratings';
import { ShopClientsService } from '../modules/shop/shop-clients.service';
import { BalanceService } from '../modules/balance/balance';
import { seedDemoPlans } from '../../prisma/seed/plans';
import {
  DEMO_CLIENTS,
  DEMO_SHOPS,
  type DemoShop,
  FACE_RATIOS,
  NEW_STYLES,
  REVIEW_TEXTS,
  STYLE_FACES,
  WALK_INS,
} from './demo-juliaca-data';
import { runDevTool } from './dev-cli';
import { DevToolError } from './dev-tools';

/**
 * Demostración completa en Juliaca (solo desarrollo; nunca en producción).
 *
 *   pnpm --filter api dev:demo-juliaca --photos <carpeta> --confirm-wipe
 *
 * **Borra** los datos de la base (deja migraciones, ajustes, datos de referencia y la auditoría) y
 * la llena desde cero: barberías y barberos independientes con planes, servicios y horarios con
 * descanso; clientes; reservas atendidas con pagos, valoraciones y promociones; ranking de
 * clientes; caja, ventas y boletas simuladas; membresías con créditos; auspiciadores con paquetes;
 * bolsa de trabajo y mensajes; y las fotos de la carpeta (`mapping.json`: estilo → archivos),
 * marcadas como "Ejemplo" (demo). La contraseña de todas las cuentas es SEED_USER_PASSWORD.
 */

/** Tablas que no se borran: migraciones, referencia, ajustes y auditoría (inmutable). */
const KEEP = [
  '_prisma_migrations',
  'spatial_ref_sys',
  'service_categories',
  'service_styles',
  'face_shape_rules',
  'peru_districts',
  'app_settings',
  'audit_log',
];
const DAY = 86_400_000;
const LIMA = -5 * 3_600_000;
const PLAN_COMMISSION: Record<string, number> = {
  gratis: 800,
  pro: 500,
  premium: 300,
  independiente_gratis: 800,
  independiente: 500,
};

/** Generador pseudoaleatorio con semilla: la demo sale igual cada vez. */
let seed = 20261022;
const rand = (): number => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const time = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);
/** Instante de Lima: día `offset` desde hoy a la hora indicada. */
const limaAt = (base: number, offset: number, hour: number, minute = 0): Date => {
  const local = new Date(base + LIMA + offset * DAY);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - LIMA,
  );
};
const ascii = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

interface Created {
  email: string;
  username: string;
  role: string;
  detail: string;
}

void runDevTool(async (app) => {
  if (!process.argv.includes('--confirm-wipe')) {
    throw new DevToolError('Este script BORRA la base. Confirma con --confirm-wipe.');
  }
  const photosIndex = process.argv.indexOf('--photos');
  const photosDir = photosIndex >= 0 ? process.argv[photosIndex + 1] : undefined;
  if (!photosDir) throw new DevToolError('Indica la carpeta de fotos con --photos <ruta>.');
  const password = process.env.SEED_USER_PASSWORD;
  if (!password || password.length < 12) {
    throw new DevToolError('Define SEED_USER_PASSWORD (12+ caracteres) en apps/api/.env.');
  }

  const prisma = app.get(PrismaService);
  const enc = app.get(EncryptionService);
  const images = app.get(ImagesService);
  const now = Date.now();
  const passwordHash = await PasswordHasher.hash(password);
  const created: Created[] = [];

  // ───────────── 1. Limpieza ─────────────
  await images.deleteDemoImages();
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const wipe = tables.map((t) => t.tablename).filter((t) => !KEEP.includes(t));
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${wipe.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  console.warn(`Base limpia: ${wipe.length} tablas vaciadas.`);

  // ───────────── 2. Planes, estilos nuevos y reglas de forma de cara ─────────────
  await seedDemoPlans(prisma);
  const plans = new Map((await prisma.plan.findMany()).map((p) => [p.code, p]));
  const haircut = await prisma.serviceCategory.findUniqueOrThrow({ where: { key: 'haircut' } });
  const lastOrder = await prisma.serviceStyle.aggregate({ _max: { sortOrder: true } });
  for (const [i, s] of NEW_STYLES.entries()) {
    const style = await prisma.serviceStyle.upsert({
      where: { key: s.key },
      update: {},
      create: {
        key: s.key,
        name: s.name,
        description: s.description,
        categoryId: haircut.id,
        sortOrder: (lastOrder._max.sortOrder ?? 0) + i + 1,
        hairTypes: s.hair,
        maintenance: s.maintenance,
        vibe: s.vibe,
      },
    });
    for (const shape of ['OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND'] as FaceShape[]) {
      await prisma.faceShapeRule.upsert({
        where: { faceShape_styleId: { faceShape: shape, styleId: style.id } },
        update: {},
        create: {
          faceShape: shape,
          styleId: style.id,
          score: s.faces.includes(shape) ? 85 : 50,
          note: s.faces.includes(shape)
            ? 'Recomendado para esta forma de cara (guía de cortes de la demo).'
            : null,
        },
      });
    }
  }
  const styles = new Map((await prisma.serviceStyle.findMany()).map((s) => [s.key, s]));
  const categories = new Map((await prisma.serviceCategory.findMany()).map((c) => [c.key, c]));

  // ───────────── 3. Cuentas ─────────────
  let phoneSeq = 1;
  const usedLocals = new Set<string>();
  async function createUser(input: {
    first: string;
    last: string;
    roles: ('CLIENT' | 'BARBER' | 'OWNER' | 'SUPPORT' | 'ADMIN')[];
    local?: string;
    detail: string;
    faceShape?: FaceShape;
  }): Promise<{ id: string; username: string }> {
    let local = input.local ?? `${ascii(input.first)}.${ascii(input.last.split(' ')[0]!)}`;
    while (usedLocals.has(local)) local = `${local}${phoneSeq}`;
    usedLocals.add(local);
    const email = `${local}@example.com`;
    const phone = `+51 951 ${String(100 + phoneSeq).padStart(3, '0')} ${String(200 + phoneSeq).padStart(3, '0')}`;
    const document = `DEMO-J${String(phoneSeq).padStart(3, '0')}`;
    phoneSeq++;
    const user = await prisma.user.create({
      data: {
        username: local,
        emailEnc: enc.encrypt(email, EncryptedField.USER_EMAIL),
        emailHash: enc.blindIndex(email, BlindIndexKind.EMAIL),
        passwordHash,
        fullName: `${input.first} ${input.last}`,
        phoneEnc: enc.encrypt(phone, EncryptedField.USER_PHONE),
        phoneHash: enc.blindIndex(phone, BlindIndexKind.PHONE),
        documentNumberEnc: enc.encrypt(document, EncryptedField.USER_DOCUMENT_NUMBER),
        documentHash: enc.blindIndex(document, BlindIndexKind.DOCUMENT),
        termsAcceptedAt: new Date(now - 90 * DAY),
        termsVersion: 'demo',
        emailVerifiedAt: new Date(now - 90 * DAY),
        createdAt: new Date(now - 90 * DAY),
        ...(input.faceShape
          ? { faceShape: input.faceShape, faceShapeConsentAt: new Date(now - 10 * DAY) }
          : {}),
        roles: { create: input.roles.map((role) => ({ role })) },
      },
      select: { id: true, username: true },
    });
    created.push({
      email,
      username: user.username,
      role: input.roles.join(', '),
      detail: input.detail,
    });
    return user;
  }

  const admin = await createUser({
    first: 'Admin',
    last: 'Charles',
    roles: ['ADMIN', 'SUPPORT'],
    local: 'admin.demo',
    detail: 'Panel web (pide activar 2FA al entrar)',
  });
  await createUser({
    first: 'Soporte',
    last: 'Charles',
    roles: ['SUPPORT'],
    local: 'soporte.demo',
    detail: 'Panel web de soporte',
  });
  const clients: { id: string; username: string; name: string }[] = [];
  for (const [i, c] of DEMO_CLIENTS.entries()) {
    const shape = i < 8 ? (['OVAL', 'ROUND', 'SQUARE', 'OBLONG'] as FaceShape[])[i % 4] : undefined;
    const u = await createUser({
      first: c.first,
      last: c.last,
      roles: ['CLIENT'],
      detail: i === 0 ? 'Cliente principal de la demo' : 'Cliente',
      faceShape: shape,
    });
    clients.push({ ...u, name: c.first });
  }

  // Todas las barberías de la demo están en Juliaca (San Román, Puno).
  const juliaca = await prisma.peruDistrict.findUniqueOrThrow({ where: { ubigeo: '211101' } });

  // ───────────── 4. Barberías, barberos, servicios y horarios ─────────────
  interface ShopCtx {
    def: DemoShop;
    id: string;
    ownerId: string;
    barbers: { id: string; userId: string; profileId: string }[];
    services: {
      id: string;
      name: string;
      price: number;
      minutes: number;
      styleKey: string | null;
    }[];
    slots: Set<string>;
  }
  const shops: ShopCtx[] = [];
  for (const def of DEMO_SHOPS) {
    const ownerUser = await createUser({
      first: def.owner.first,
      last: def.owner.last,
      roles: ['OWNER', 'BARBER', 'CLIENT'],
      detail: `Dueño de ${def.name} (${def.plan})`,
    });
    const shop = await prisma.barbershop.create({
      data: {
        name: def.name,
        description: def.description,
        address: def.address,
        latitude: def.latitude,
        longitude: def.longitude,
        districtId: juliaca.id,
        timezone: 'America/Lima',
        phone: `+51 951 ${String(300 + shops.length).padStart(3, '0')} 000`,
        type: def.type,
        status: 'OPEN',
        ownerDocumentType: 'DNI',
        ownerDocumentEnc: enc.encrypt(
          `4${String(1000000 + shops.length).slice(1)}0`,
          EncryptedField.BARBERSHOP_OWNER_DOCUMENT,
        ),
        ownerDocumentHash: enc.blindIndex(
          `4${String(1000000 + shops.length).slice(1)}0`,
          BlindIndexKind.DOCUMENT,
        ),
        createdAt: new Date(now - 80 * DAY),
        members: { create: { userId: ownerUser.id, role: 'OWNER' } },
      },
      select: { id: true },
    });
    // Horario con descanso de 13:00 a 14:00 (dos franjas por día).
    const days = def.sunday ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6];
    const windows = (day: number): [string, string][] =>
      day === 0
        ? [['10:00', '14:00']]
        : [
            ['09:00', '13:00'],
            ['14:00', '20:00'],
          ];
    for (const day of days) {
      for (const [open, close] of windows(day)) {
        await prisma.businessHour.create({
          data: {
            barbershopId: shop.id,
            dayOfWeek: day,
            openTime: time(open),
            closeTime: time(close),
          },
        });
      }
    }
    // Servicios: uno por estilo de la casa, más barba y afeitado.
    const services: ShopCtx['services'] = [];
    for (const key of def.styles) {
      const style = styles.get(key);
      if (!style) continue;
      const price = 1800 + Math.round(rand() * 17) * 100;
      const s = await prisma.service.create({
        data: {
          barbershopId: shop.id,
          name: `Corte ${style.name}`,
          description: style.description ?? null,
          priceAmount: price,
          currency: 'PEN',
          durationMinutes: 30 + (price > 2800 ? 15 : 0),
          categoryId: haircut.id,
          styleId: style.id,
        },
      });
      services.push({ id: s.id, name: s.name, price, minutes: s.durationMinutes, styleKey: key });
    }
    for (const extra of [
      { name: 'Corte y barba', price: 3500, minutes: 45, cat: 'haircut_beard' },
      { name: 'Perfilado de barba', price: 1500, minutes: 20, cat: 'beard' },
      { name: 'Afeitado clásico con toalla caliente', price: 2000, minutes: 25, cat: 'shave' },
    ]) {
      const category = categories.get(extra.cat);
      if (!category) continue;
      const s = await prisma.service.create({
        data: {
          barbershopId: shop.id,
          name: extra.name,
          priceAmount: extra.price,
          currency: 'PEN',
          durationMinutes: extra.minutes,
          categoryId: category.id,
        },
      });
      services.push({
        id: s.id,
        name: s.name,
        price: extra.price,
        minutes: extra.minutes,
        styleKey: null,
      });
    }
    // Barberos (el primero es el dueño), cada uno con su perfil profesional.
    const barbers: ShopCtx['barbers'] = [];
    for (const [i, b] of def.barbers.entries()) {
      const userId =
        i === 0
          ? ownerUser.id
          : (
              await createUser({
                first: b.first,
                last: b.last,
                roles: ['BARBER', 'CLIENT'],
                detail: `Barbero en ${def.name}`,
              })
            ).id;
      const profile = await prisma.barberProfile.create({
        data: {
          userId,
          displayName: `${b.first} ${b.last.split(' ')[0]}`,
          headline: b.headline,
          bio: `${b.headline}. ${b.years} años de experiencia en Juliaca.`,
          yearsExperience: b.years,
          district: 'Juliaca',
          districtId: juliaca.id,
          availableForWork: false,
          specialties: {
            create: def.styles
              .slice(0, 3)
              .flatMap((k) => (styles.get(k) ? [{ styleId: styles.get(k)!.id }] : [])),
          },
        },
      });
      const barber = await prisma.barber.create({
        data: {
          barbershopId: shop.id,
          userId,
          displayName: b.first,
          barberProfileId: profile.id,
          yearsExperience: b.years,
          bio: b.headline,
          commissionBp: def.plan === 'premium' ? 4000 : def.plan === 'pro' ? 3500 : null,
          createdAt: new Date(now - 70 * DAY + i * DAY),
          services: { create: services.map((s) => ({ serviceId: s.id })) },
          specialties: {
            create: def.styles
              .slice(0, 3)
              .flatMap((k) => (styles.get(k) ? [{ styleId: styles.get(k)!.id }] : [])),
          },
        },
      });
      for (const day of days) {
        for (const [start, end] of windows(day)) {
          await prisma.barberSchedule.create({
            data: {
              barberId: barber.id,
              dayOfWeek: day,
              startTime: time(start),
              endTime: time(end),
            },
          });
        }
      }
      barbers.push({ id: barber.id, userId, profileId: profile.id });
    }
    shops.push({ def, id: shop.id, ownerId: ownerUser.id, barbers, services, slots: new Set() });
  }

  // ───────────── 5. Planes contratados ─────────────
  for (const s of shops) {
    const plan = plans.get(s.def.plan)!;
    if (!s.def.subscription) continue;
    const status = s.def.subscription;
    const sub = await prisma.subscription.create({
      data: {
        planId: plan.id,
        barbershopId: s.id,
        payerUserId: s.ownerId,
        interval: 'MONTHLY',
        status,
        priceAmount: plan.priceMonthly,
        currency: 'PEN',
        provider: 'FAKE',
        providerSubscriptionId: `demo-${randomUUID()}`,
        trialEndsAt: status === 'TRIALING' ? new Date(now + 5 * DAY) : null,
        currentPeriodStart: new Date(now - (status === 'TRIALING' ? 9 : 18) * DAY),
        currentPeriodEnd: new Date(now + (status === 'TRIALING' ? 5 : 12) * DAY),
        pastDueSince: status === 'PAST_DUE' ? new Date(now - 3 * DAY) : null,
        graceUntil: status === 'PAST_DUE' ? new Date(now + 4 * DAY) : null,
        cancelAtPeriodEnd: status === 'CANCELED',
        canceledAt: status === 'CANCELED' ? new Date(now - 2 * DAY) : null,
        cancelReason: status === 'CANCELED' ? 'Prefiero el plan gratis por ahora' : null,
        createdAt: new Date(now - 50 * DAY),
      },
    });
    if (status !== 'TRIALING') {
      for (const [i, ago] of [48, 18].entries()) {
        const failed = status === 'PAST_DUE' && i === 1;
        await prisma.billingCharge.create({
          data: {
            purpose: 'SUBSCRIPTION',
            subscriptionId: sub.id,
            amount: plan.priceMonthly,
            currency: 'PEN',
            status: failed ? 'FAILED' : 'PAID',
            provider: 'FAKE',
            providerPaymentId: `demo-pay-${randomUUID()}`,
            failureReason: failed ? 'Fondos insuficientes' : null,
            paidAt: failed ? null : new Date(now - ago * DAY),
          },
        });
      }
    }
    if (s.def.plan !== 'gratis' && s.def.plan !== 'independiente_gratis') {
      await prisma.invoicingConfig.create({
        data: { barbershopId: s.id, provider: 'FAKE', enabled: true, series: 'B001' },
      });
    }
  }

  // ───────────── 6. Fotos (Ejemplo) con forma de cara ─────────────
  const mapping = JSON.parse(await readFile(join(photosDir, 'mapping.json'), 'utf8')) as {
    key: string | null;
    images: string[];
  }[];
  const capacity = new Map(shops.map((s) => [s.id, s.def.photos]));
  const coverOf = new Map<string, string>();
  let photoCount = 0;
  for (const group of mapping) {
    const style = group.key ? styles.get(group.key) : undefined;
    if (!style) continue;
    const owners = shops.filter((s) => s.def.styles.includes(style.key));
    const fallback = [...shops].sort((a, b) => b.def.photos - a.def.photos);
    for (const [i, file] of group.images.entries()) {
      const candidates = [...owners.slice(i % Math.max(owners.length, 1)), ...owners, ...fallback];
      const shop = candidates.find((s) => (capacity.get(s.id) ?? 0) > 0);
      if (!shop) continue;
      capacity.set(shop.id, (capacity.get(shop.id) ?? 0) - 1);
      const imageId = await images.createDemoImage({
        file: await readFile(join(photosDir, file)),
        barbershopId: shop.id,
        uploadedById: shop.ownerId,
        styleIds: [style.id],
        caption: `Ejemplo: ${style.name}`,
        source: {
          provider: 'documento',
          author: 'Guía "Cortes de pelo para Hombre" (solo demo)',
          file,
        },
      });
      const shape = pick(STYLE_FACES[style.key] ?? ['OVAL']) as FaceShape;
      const [l, f, j] = FACE_RATIOS[shape]!;
      const jitter = () => (rand() - 0.5) * 0.04;
      const barber = pick(shop.barbers);
      const service = shop.services.find((sv) => sv.styleKey === style.key);
      await prisma.image.update({
        where: { id: imageId },
        data: {
          barberId: barber.id,
          barberProfileId: barber.profileId,
          faceShape: shape,
          faceRatioLength: l + jitter(),
          faceRatioForehead: f + jitter(),
          faceRatioJaw: j + jitter(),
          serviceId: service?.id ?? null,
        },
      });
      if (service && !coverOf.has(service.id)) {
        coverOf.set(service.id, imageId);
        await prisma.service.update({ where: { id: service.id }, data: { coverImageId: imageId } });
      }
      photoCount++;
    }
  }
  console.warn(`Fotos de ejemplo cargadas: ${photoCount}.`);

  // ───────────── 7. Promociones y cupones ─────────────
  const welcome = await prisma.promotion.create({
    data: {
      scope: 'PLATFORM',
      name: 'Bienvenido a Charles: 15 % en tu primera reserva',
      type: 'PERCENTAGE',
      value: 15,
      startsAt: new Date(now - 60 * DAY),
      maxPerUser: 1,
      requiresCoupon: true,
      createdById: admin.id,
      coupons: { create: { code: 'BIENVENIDO15' } },
    },
  });
  await prisma.promotion.create({
    data: {
      scope: 'PLATFORM',
      name: 'Feria de Juliaca: S/ 5 de descuento',
      type: 'FIXED_AMOUNT',
      value: 500,
      currency: 'PEN',
      startsAt: new Date(now - 5 * DAY),
      endsAt: new Date(now + 10 * DAY),
      maxRedemptions: 200,
      createdById: admin.id,
    },
  });
  const shopPromos = new Map<string, { id: string; percent: number }>();
  for (const s of shops.filter((x) => ['pro', 'premium', 'independiente'].includes(x.def.plan))) {
    const tuesday = await prisma.promotion.create({
      data: {
        scope: 'BARBERSHOP',
        scopeId: s.id,
        barbershopId: s.id,
        name: 'Martes de fade: 20 %',
        type: 'PERCENTAGE',
        value: 20,
        startsAt: new Date(now - 45 * DAY),
        rules: { daysOfWeek: [2] },
        createdById: s.ownerId,
      },
    });
    shopPromos.set(s.id, { id: tuesday.id, percent: 20 });
    await prisma.promotion.create({
      data: {
        scope: 'BARBERSHOP',
        scopeId: s.id,
        barbershopId: s.id,
        name: 'Clientes Oro: 25 % siempre',
        type: 'PERCENTAGE',
        value: 25,
        startsAt: new Date(now - 30 * DAY),
        rules: { minTier: 'GOLD' },
        createdById: s.ownerId,
      },
    });
    await prisma.promotion.create({
      data: {
        scope: 'BARBERSHOP',
        scopeId: s.id,
        barbershopId: s.id,
        name: `Cupón de ${s.def.name}: 10 %`,
        type: 'PERCENTAGE',
        value: 10,
        startsAt: new Date(now - 30 * DAY),
        requiresCoupon: true,
        maxPerUser: 2,
        createdById: s.ownerId,
        coupons: { create: { code: `${ascii(s.def.key).toUpperCase().slice(0, 8)}10` } },
      },
    });
  }

  // ───────────── 7b. Cuentas de Mercado Pago vinculadas (Marketplace, simuladas) ─────────────
  // Imperial y Fade House cobran directo en su cuenta (Charles retiene su comisión); las demás
  // cobran con la cuenta de Charles y acumulan saldo a favor.
  const sellerShops = new Set<string>();
  for (const [i, key] of ['imperial', 'fadehouse'].entries()) {
    const s = shops.find((x) => x.def.key === key)!;
    await prisma.sellerAccount.create({
      data: {
        barbershopId: s.id,
        provider: 'FAKE',
        status: 'CONNECTED',
        providerUserId: String(310_000_100 + i),
        accessTokenEnc: enc.encrypt(`FAKE-SELLER-demo-${key}`, EncryptedField.SELLER_ACCESS_TOKEN),
        refreshTokenEnc: enc.encrypt(`FAKE-RT-demo-${key}`, EncryptedField.SELLER_REFRESH_TOKEN),
        tokenExpiresAt: new Date(now + 170 * DAY),
        connectedAt: new Date(now - 40 * DAY),
      },
    });
    sellerShops.add(s.id);
  }

  // ───────────── 8. Reservas, pagos, valoraciones ─────────────
  const reviewers = new Map<string, number>();
  let bookings = 0;
  async function book(
    s: ShopCtx,
    input: {
      client: (typeof clients)[number];
      dayOffset: number;
      status: 'ATTENDED' | 'CONFIRMED' | 'NO_SHOW' | 'CANCELLED';
    },
  ): Promise<void> {
    const barber = pick(s.barbers);
    const service = pick(s.services);
    let hour = 9 + Math.floor(rand() * 10);
    if (hour === 13) hour = 14;
    const startAt = limaAt(now, input.dayOffset, hour);
    const local = new Date(startAt.getTime() + LIMA);
    const weekday = local.getUTCDay();
    if (!s.def.sunday && weekday === 0) return;
    if (weekday === 0 && (hour < 10 || hour >= 13)) return;
    const slot = `${barber.id}:${startAt.toISOString()}`;
    if (s.slots.has(slot)) return;
    s.slots.add(slot);
    const promo = shopPromos.get(s.id);
    const discount = promo && weekday === 2 ? Math.round((service.price * promo.percent) / 100) : 0;
    const net = service.price - discount;
    const commission = Math.round((net * (PLAN_COMMISSION[s.def.plan] ?? 0)) / 10_000);
    const createdAt = new Date(startAt.getTime() - 2 * DAY);
    const style = service.styleKey ? styles.get(service.styleKey) : undefined;
    const booking = await prisma.booking.create({
      data: {
        clientId: input.client.id,
        barbershopId: s.id,
        barberId: barber.id,
        barberProfileId: barber.profileId,
        styleId: style?.id ?? null,
        serviceId: service.id,
        startAt,
        endAt: new Date(startAt.getTime() + service.minutes * 60_000),
        status: input.status,
        ...(input.status === 'CANCELLED'
          ? {
              cancelledByRole: 'CLIENT' as const,
              cancelledById: input.client.id,
              cancelReason: 'No podré asistir',
            }
          : {}),
        barberChosenByClient: true,
        serviceNameSnapshot: service.name,
        durationMinutesSnapshot: service.minutes,
        subtotalAmount: service.price,
        discountTotalAmount: discount,
        feeTotalAmount: 0,
        totalAmount: net,
        commissionAmount: commission,
        commissionPayer: 'BARBERSHOP',
        currency: 'PEN',
        idempotencyKey: randomUUID(),
        createdAt,
        priceLines: {
          create: [
            { type: 'SERVICE', description: service.name, amount: service.price },
            ...(discount > 0
              ? [
                  {
                    type: 'DISCOUNT' as const,
                    description: 'Martes de fade: 20 %',
                    amount: discount,
                    sourceType: 'promotion',
                    sourceId: promo!.id,
                  },
                ]
              : []),
          ],
        },
        statusHistory: {
          create: [
            { fromStatus: null, toStatus: 'PENDING_PAYMENT', createdAt },
            {
              fromStatus: 'PENDING_PAYMENT',
              toStatus: 'CONFIRMED',
              createdAt: new Date(createdAt.getTime() + 60_000),
            },
            ...(input.status !== 'CONFIRMED'
              ? [
                  {
                    fromStatus: 'CONFIRMED' as const,
                    toStatus: input.status,
                    createdAt:
                      input.status === 'CANCELLED' ? new Date(startAt.getTime() - DAY) : startAt,
                    reason: input.status === 'CANCELLED' ? 'client_cancelled' : null,
                  },
                ]
              : []),
          ],
        },
        payments: {
          create: {
            provider: 'FAKE',
            status: input.status === 'CANCELLED' ? 'REFUNDED' : 'SUCCEEDED',
            payee: sellerShops.has(s.id) ? 'SELLER' : 'PLATFORM',
            marketplaceFee: sellerShops.has(s.id) ? commission : null,
            amount: net,
            currency: 'PEN',
            method: pick(['card', 'yape']),
            idempotencyKey: randomUUID(),
            startedAt: createdAt,
            confirmedAt: new Date(createdAt.getTime() + 60_000),
          },
        },
      },
      include: { payments: true },
    });
    if (discount > 0) {
      await prisma.promotionRedemption.create({
        data: {
          promotionId: promo!.id,
          userId: input.client.id,
          bookingId: booking.id,
          discountAmount: discount,
          currency: 'PEN',
          fundedBy: 'BARBERSHOP',
        },
      });
    }
    if (input.status === 'CANCELLED') {
      await prisma.refund.create({
        data: {
          paymentId: booking.payments[0]!.id,
          amount: net,
          reasonType: 'CLIENT_CANCELLATION',
          status: 'SUCCEEDED',
          idempotencyKey: randomUUID(),
          requestedAt: new Date(startAt.getTime() - DAY),
          processedAt: new Date(startAt.getTime() - DAY + 60_000),
        },
      });
    }
    if (input.status === 'ATTENDED' && rand() < 0.7) {
      const r = pick(REVIEW_TEXTS);
      const respond = rand() < 0.35;
      await prisma.review.create({
        data: {
          bookingId: booking.id,
          clientId: input.client.id,
          barbershopId: s.id,
          barberId: barber.id,
          barberProfileId: barber.profileId,
          rating: r.rating,
          comment: r.text,
          createdAt: new Date(startAt.getTime() + DAY),
          ...(respond
            ? {
                responseText: '¡Gracias por venir! Te esperamos pronto.',
                responseById: s.ownerId,
                responseAt: new Date(startAt.getTime() + 2 * DAY),
                responseStatus: 'VISIBLE' as const,
              }
            : {}),
        },
      });
      reviewers.set(s.id, (reviewers.get(s.id) ?? 0) + 1);
    }
    bookings++;
  }
  const volume: Record<string, number> = {
    premium: 45,
    pro: 28,
    gratis: 12,
    independiente: 18,
    independiente_gratis: 8,
  };
  for (const s of shops) {
    // Clientes habituales de la barbería (para que el ranking tenga niveles).
    const regulars = [...clients].sort(() => rand() - 0.5).slice(0, 8);
    for (let i = 0; i < (volume[s.def.plan] ?? 10); i++) {
      const client =
        i % 3 === 0 ? regulars[0]! : i % 2 === 0 ? pick(regulars.slice(0, 3)) : pick(clients);
      const roll = rand();
      await book(s, {
        client,
        dayOffset: -1 - Math.floor(rand() * 45),
        status: roll < 0.08 ? 'NO_SHOW' : roll < 0.13 ? 'CANCELLED' : 'ATTENDED',
      });
    }
    for (let i = 0; i < 5; i++) {
      await book(s, {
        client: pick(clients),
        dayOffset: 1 + Math.floor(rand() * 6),
        status: 'CONFIRMED',
      });
    }
  }
  await app.get(RatingsVerifier).verifyAll();
  console.warn(`Reservas creadas: ${bookings}.`);

  // ───────────── 9. Clientes del local, caja, ventas y boletas ─────────────
  let sales = 0;
  for (const s of shops) {
    const walkIns: string[] = [];
    for (const name of WALK_INS.slice(0, s.def.plan === 'gratis' ? 3 : 5)) {
      const c = await prisma.shopClient.create({
        data: {
          barbershopId: s.id,
          displayName: name,
          phoneEnc: enc.encrypt(
            `+51 951 ${String(400 + sales).padStart(3, '0')} 111`,
            EncryptedField.SHOP_CLIENT_PHONE,
          ),
          notes: pick([
            'Le gusta el degradado bajo',
            'Siempre pide navaja',
            'Viene los sábados',
            null,
          ]),
          preferences: pick(['Máquina 1 a los costados', 'Tijera arriba', null]),
          isRegular: rand() < 0.5,
          createdAt: new Date(now - 40 * DAY),
        },
      });
      walkIns.push(c.id);
    }
    const config = await prisma.invoicingConfig.findUnique({ where: { barbershopId: s.id } });
    let invoiceNumber = 1;
    const days = [-6, -5, -4, -3, -2, -1, 0];
    for (const offset of days) {
      const openedAt = limaAt(now, offset, 9);
      const isToday = offset === 0;
      const session = await prisma.cashSession.create({
        data: { barbershopId: s.id, openedById: s.ownerId, openedAt, openingAmount: 5000 },
      });
      let cash = 0;
      const perDay = s.def.plan === 'gratis' || s.def.plan === 'independiente_gratis' ? 1 : 2;
      for (let i = 0; i < perDay; i++) {
        const service = pick(s.services.filter((x) => x.styleKey));
        const method = pick(['CASH', 'CASH', 'YAPE', 'CARD'] as const);
        const soldAt = limaAt(now, offset, 10 + i * 3, 15);
        const sale = await prisma.localSale.create({
          data: {
            barbershopId: s.id,
            shopClientId: pick(walkIns),
            barberId: pick(s.barbers).id,
            cashSessionId: session.id,
            subtotalAmount: service.price,
            discountAmount: 0,
            totalAmount: service.price,
            currency: 'PEN',
            paymentMethod: method,
            createdById: s.ownerId,
            idempotencyKey: randomUUID(),
            soldAt,
            lines: {
              create: {
                serviceId: service.id,
                description: service.name,
                quantity: 1,
                unitAmount: service.price,
                totalAmount: service.price,
              },
            },
          },
        });
        if (method === 'CASH') cash += service.price;
        if (config && rand() < 0.6) {
          const number = invoiceNumber++;
          await prisma.invoice.create({
            data: {
              barbershopId: s.id,
              saleId: sale.id,
              series: config.series,
              number,
              status: 'ISSUED',
              totalAmount: service.price,
              taxAmount: service.price - Math.round(service.price / 1.18),
              currency: 'PEN',
              provider: 'FAKE',
              providerData: { simulated: true },
              pdfUrl: `https://fake.invoices/${config.series}-${String(number).padStart(8, '0')}.pdf`,
              attempts: 1,
              issuedAt: soldAt,
            },
          });
        }
        sales++;
      }
      if (!isToday) {
        const expected = 5000 + cash;
        await prisma.cashSession.update({
          where: { id: session.id },
          data: {
            closedAt: limaAt(now, offset, 20, 30),
            closedById: s.ownerId,
            expectedAmount: expected,
            countedAmount: expected - (rand() < 0.2 ? 200 : 0),
          },
        });
      }
    }
    if (config)
      await prisma.invoicingConfig.update({
        where: { barbershopId: s.id },
        data: { nextNumber: invoiceNumber },
      });
  }
  await app.get(ShopClientsService).recomputeAll();
  console.warn(`Ventas en el local: ${sales}.`);

  // ───────────── 10. Membresías (barberías Premium) ─────────────
  for (const s of shops.filter((x) => x.def.plan === 'premium')) {
    const covered = s.services.filter((x) => x.styleKey).map((x) => x.id);
    const monthly = await prisma.membershipPlan.create({
      data: {
        barbershopId: s.id,
        name: 'Corte mensual',
        description: '4 cortes al mes.',
        priceAmount: 9000,
        currency: 'PEN',
        creditsPerPeriod: 4,
        services: { create: covered.map((serviceId) => ({ serviceId })) },
      },
    });
    await prisma.membershipPlan.create({
      data: {
        barbershopId: s.id,
        name: 'Corte + barba',
        description: '4 cortes y 4 perfilados al mes.',
        priceAmount: 15000,
        currency: 'PEN',
        creditsPerPeriod: 8,
      },
    });
    for (const [i, client] of clients.slice(i0(s), i0(s) + 3).entries()) {
      const m = await prisma.membership.create({
        data: {
          membershipPlanId: monthly.id,
          barbershopId: s.id,
          userId: client.id,
          status: i === 2 ? 'CANCELED' : 'ACTIVE',
          priceAmount: 9000,
          currency: 'PEN',
          creditsPerPeriod: 4,
          provider: 'FAKE',
          providerSubscriptionId: `demo-mem-${randomUUID()}`,
          currentPeriodStart: new Date(now - 12 * DAY),
          currentPeriodEnd: new Date(now + 18 * DAY),
          cancelAtPeriodEnd: i === 2,
          canceledAt: i === 2 ? new Date(now - DAY) : null,
        },
      });
      const charge = await prisma.billingCharge.create({
        data: {
          purpose: 'MEMBERSHIP',
          membershipId: m.id,
          amount: 9000,
          currency: 'PEN',
          status: 'PAID',
          provider: 'FAKE',
          providerPaymentId: `demo-mp-${randomUUID()}`,
          paidAt: new Date(now - 12 * DAY),
        },
      });
      await prisma.membershipCreditLot.create({
        data: {
          membershipId: m.id,
          chargeId: charge.id,
          granted: 4,
          remaining: 4 - i,
          expiresAt: new Date(now + 48 * DAY),
        },
      });
    }
  }

  // ───────────── 11. Destacados ─────────────
  const featuredShops = shops.filter((x) => ['premium', 'pro'].includes(x.def.plan)).slice(0, 3);
  for (const [i, s] of featuredShops.entries()) {
    await prisma.featuredListing.create({
      data: {
        barbershopId: s.id,
        startsAt: new Date(now - DAY),
        endsAt: new Date(now + (i + 2) * DAY),
        priority: 3 - i,
        createdById: i === 0 ? admin.id : s.ownerId,
        note: i === 0 ? 'Destacado por Charles' : 'Días del plan',
        fromPlan: i !== 0,
      },
    });
  }

  // ───────────── 12. Auspiciadores con paquetes ─────────────
  const packages = new Map((await prisma.sponsorPackage.findMany()).map((p) => [p.code, p]));
  const sponsorDefs = [
    {
      name: 'Cera Andina',
      pkg: 'crecimiento',
      audience: 'CLIENTS' as const,
      slots: ['home_banner', 'search_top'],
      products: [
        ['Cera mate Andina 100 g', 'S/ 25'],
        ['Pomada brillo fuerte', 'S/ 28'],
      ],
    },
    {
      name: 'Navaja de Oro Pro',
      pkg: 'destacado',
      audience: 'BARBERSHOPS' as const,
      slots: ['shop_dashboard'],
      products: [
        ['Máquina inalámbrica Pro', 'S/ 320'],
        ['Set de peines de carbono', 'S/ 45'],
      ],
    },
    {
      name: 'Barba Fuerte',
      pkg: 'basico',
      audience: 'ALL' as const,
      slots: ['booking_success'],
      products: [['Aceite para barba 30 ml', 'S/ 35']],
    },
  ];
  for (const def of sponsorDefs) {
    const pkg = packages.get(def.pkg)!;
    const sponsor = await prisma.sponsor.create({
      data: {
        name: def.name,
        contactEnc: enc.encrypt(
          `contacto@${ascii(def.name)}.example.com`,
          EncryptedField.SPONSOR_CONTACT,
        ),
        products: {
          create: def.products.map(([name, price], i) => ({
            name: name!,
            description: `${name} — producto de ${def.name} (ejemplo).`,
            actionUrl: `https://example.com/${ascii(def.name)}/${i + 1}`,
            priceText: price!,
            sortOrder: i,
          })),
        },
      },
    });
    const campaign = await prisma.sponsorCampaign.create({
      data: {
        sponsorId: sponsor.id,
        name: `${def.name} — campaña de lanzamiento`,
        startsAt: new Date(now - 5 * DAY),
        endsAt: new Date(now + pkg.durationDays * DAY),
        audience: def.audience,
        status: 'ACTIVE',
        impressionsLimit: pkg.impressionsLimit,
        placements: {
          create: def.slots.map((slotKey, i) => ({
            slotKey,
            title: i === 0 ? `${def.name}: estilo que dura todo el día` : `Prueba ${def.name}`,
            actionUrl: `https://example.com/${ascii(def.name)}`,
            priority: 1,
          })),
        },
      },
    });
    const purchase = await prisma.sponsorPackagePurchase.create({
      data: {
        sponsorId: sponsor.id,
        packageId: pkg.id,
        campaignId: campaign.id,
        priceAmount: pkg.priceAmount,
        currency: pkg.currency,
        status: 'PAID',
        paidAt: new Date(now - 5 * DAY),
        createdById: admin.id,
      },
    });
    await prisma.billingCharge.create({
      data: {
        purpose: 'SPONSOR_PACKAGE',
        sponsorPurchaseId: purchase.id,
        amount: pkg.priceAmount,
        currency: pkg.currency,
        status: 'PAID',
        provider: 'FAKE',
        providerPaymentId: `demo-spk-${randomUUID()}`,
        paidAt: new Date(now - 5 * DAY),
      },
    });
  }

  // ───────────── 13. Bolsa de trabajo y mensajes ─────────────
  const seekers = [];
  for (const [first, last, headline] of [
    ['Ruth', 'Condori Apaza', 'Barbera con 4 años de experiencia, fades y diseños'],
    ['Kevin', 'Torres Quispe', 'Recién egresado de academia, busco mi primera barbería'],
  ] as const) {
    const u = await createUser({
      first,
      last,
      roles: ['BARBER', 'CLIENT'],
      detail: 'Barbero buscando trabajo',
    });
    seekers.push(
      await prisma.barberProfile.create({
        data: {
          userId: u.id,
          displayName: `${first} ${last.split(' ')[0]}`,
          headline,
          bio: headline,
          yearsExperience: first === 'Ruth' ? 4 : 0,
          district: 'Juliaca',
          districtId: juliaca.id,
          availableForWork: true,
        },
      }),
    );
  }
  const fadeHouse = shops.find((x) => x.def.key === 'fadehouse')!;
  const santaBarbara = shops.find((x) => x.def.key === 'santabarbara')!;
  const posting = await prisma.jobPosting.create({
    data: {
      barbershopId: fadeHouse.id,
      title: 'Barbero con experiencia en fades',
      description:
        'Buscamos barbero con buen manejo de degradados y diseños. Ambiente joven, comisión atractiva.',
      employmentType: 'FULL_TIME',
      compensationText: 'S/ 1 200 + 40 % de comisión',
      payMin: 120_000,
      payMax: 180_000,
      payType: 'MIXED',
      payPeriod: 'MONTH',
      negotiable: true,
      districtId: juliaca.id,
      requirements: [
        '2 años de experiencia en degradados',
        'Herramientas propias',
        'Buen trato al cliente',
      ],
      selectionProcess: 'TRIAL',
      schedule: 'Lunes a sábado, 9:00–13:00 y 14:00–20:00',
      styleIds: [styles.get('fade_mid')!.id, styles.get('hair_design')!.id],
      createdById: fadeHouse.ownerId,
    },
  });
  await prisma.jobPosting.create({
    data: {
      barbershopId: santaBarbara.id,
      title: 'Barbero para fines de semana',
      description: 'Sábados y domingos, cortes modernos. Ideal para complementar ingresos.',
      employmentType: 'WEEKENDS',
      compensationText: '50 % por corte',
      payType: 'COMMISSION',
      payPeriod: 'PER_SERVICE',
      negotiable: false,
      districtId: juliaca.id,
      requirements: ['Cortes modernos', 'Disponibilidad sábados y domingos'],
      selectionProcess: 'INTERVIEW',
      schedule: 'Sábados y domingos, 10:00–19:00',
      styleIds: [styles.get('undercut')!.id],
      createdById: santaBarbara.ownerId,
    },
  });
  await prisma.jobApplication.create({
    data: {
      postingId: posting.id,
      barberProfileId: seekers[0]!.id,
      message: 'Hola, tengo 4 años haciendo fades. ¿Puedo hacer una prueba?',
      status: 'SHORTLISTED',
    },
  });
  await prisma.jobApplication.create({
    data: {
      postingId: posting.id,
      barberProfileId: seekers[1]!.id,
      message: 'Me encantaría aprender con ustedes.',
    },
  });

  // Ofertas directas de trabajo: una pendiente (Ruth) y una rechazada (Kevin).
  const navaja = shops.find((x) => x.def.key === 'navaja')!;
  const andino = shops.find((x) => x.def.key === 'andino')!;
  await prisma.jobOffer.create({
    data: {
      barbershopId: navaja.id,
      barberProfileId: seekers[0]!.id,
      title: 'Barbera principal de fades',
      message: 'Vimos tu perfil y tus trabajos. Te ofrecemos un puesto fijo con comisión.',
      employmentType: 'FULL_TIME',
      payMin: 150_000,
      payMax: 200_000,
      payType: 'MIXED',
      payPeriod: 'MONTH',
      schedule: 'Lunes a sábado, 10:00–20:00',
      status: 'PENDING',
      expiresAt: new Date(now + 6 * DAY),
      createdById: navaja.ownerId,
      createdAt: new Date(now - DAY),
    },
  });
  await prisma.jobOffer.create({
    data: {
      barbershopId: andino.id,
      barberProfileId: seekers[1]!.id,
      title: 'Ayudante de barbería',
      employmentType: 'PART_TIME',
      payMin: 4_000,
      payType: 'FIXED',
      payPeriod: 'DAY',
      status: 'REJECTED',
      responseNote: 'Gracias, por ahora busco algo de tiempo completo.',
      respondedAt: new Date(now - 2 * DAY),
      expiresAt: new Date(now + 2 * DAY),
      createdById: andino.ownerId,
      createdAt: new Date(now - 5 * DAY),
    },
  });

  // ───────────── 14. Saldo a favor: plan pagado con saldo y una transferencia ─────────────
  const balances = app.get(BalanceService);
  const santa = shops.find((x) => x.def.key === 'santabarbara')!;
  const santaSub = await prisma.subscription.findFirstOrThrow({
    where: { barbershopId: santa.id },
  });
  const lastCharge = await prisma.billingCharge.findFirstOrThrow({
    where: { subscriptionId: santaSub.id },
    orderBy: { paidAt: 'desc' },
  });
  await prisma.subscription.update({
    where: { id: santaSub.id },
    data: {
      provider: 'BALANCE',
      providerSubscriptionId: null,
      metadata: { paidWithBalance: true },
    },
  });
  const santaMove = await prisma.balanceMovement.create({
    data: {
      barbershopId: santa.id,
      type: 'SUBSCRIPTION_PAYMENT',
      amount: -lastCharge.amount,
      subscriptionId: santaSub.id,
      createdAt: lastCharge.paidAt ?? new Date(now - 18 * DAY),
    },
  });
  await prisma.billingCharge.update({
    where: { id: lastCharge.id },
    data: { provider: 'BALANCE', providerPaymentId: santaMove.id },
  });
  const donlucho = shops.find((x) => x.def.key === 'donlucho')!;
  const available = (await balances.balanceOf(donlucho.id)).available;
  const payout = Math.floor((available * 0.6) / 100) * 100;
  if (payout > 0) {
    await prisma.balanceMovement.create({
      data: {
        barbershopId: donlucho.id,
        type: 'PAYOUT',
        amount: -payout,
        reference: 'OP-000184522',
        note: 'Transferencia quincenal (BCP)',
        createdAt: new Date(now - 7 * DAY),
      },
    });
  }

  const imperial = shops.find((x) => x.def.key === 'imperial')!;
  const chat = await prisma.conversation.create({
    data: {
      barbershopId: imperial.id,
      userId: clients[0]!.id,
      kind: 'CLIENT',
      lastMessageAt: new Date(now - 2 * 3_600_000),
    },
  });
  for (const [i, [side, text]] of (
    [
      ['USER', 'Hola, ¿tienen turno el sábado en la tarde para un fade?'],
      ['BARBERSHOP', '¡Hola Diego! Sí, a las 4 pm con Jhon. ¿Te lo reservamos?'],
      ['USER', 'Perfecto, ya reservé por la app. ¡Gracias!'],
    ] as const
  ).entries()) {
    await prisma.message.create({
      data: {
        conversationId: chat.id,
        side,
        senderId: side === 'USER' ? clients[0]!.id : imperial.ownerId,
        bodyEnc: enc.encrypt(text, EncryptedField.MESSAGE_BODY),
        createdAt: new Date(now - (4 - i) * 3_600_000),
      },
    });
  }

  // ───────────── Resumen ─────────────
  const counts = await Promise.all([
    prisma.barbershop.count(),
    prisma.user.count(),
    prisma.booking.count(),
    prisma.review.count(),
    prisma.image.count(),
    prisma.localSale.count(),
    prisma.shopClient.count(),
    prisma.membership.count(),
  ]);
  console.warn(
    `Listo: ${counts[0]} barberías, ${counts[1]} cuentas, ${counts[2]} reservas, ${counts[3]} valoraciones, ` +
      `${counts[4]} fotos, ${counts[5]} ventas, ${counts[6]} clientes del panel, ${counts[7]} membresías.`,
  );
  console.warn('CUENTAS:');
  for (const c of created) console.warn(`${c.role}\t${c.email}\t${c.username}\t${c.detail}`);
  void welcome;
});

/** Desde qué cliente empiezan los miembros de cada barbería Premium (distintos por barbería). */
function i0(s: { def: DemoShop }): number {
  return s.def.key === 'imperial' ? 0 : 3;
}

export type { Prisma };
