import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { BlindIndexKind, EncryptedField } from '../common/crypto/encryption-contexts';
import { EncryptionService } from '../common/crypto/encryption.service';
import { PasswordHasher } from '../common/crypto/password-hasher';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import type { FaceShape } from '../generated/prisma/enums';
import { IMAGE_STORAGE, type ImageStorage } from '../modules/images/image-storage';
import { ImagesService } from '../modules/images/images.service';
import { VideosService } from '../modules/videos/videos.service';
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

  // ───────────── 12. Marcas auspiciadoras: Tienda, anuncios, paquetes y videos ─────────────
  // Fotos de ejemplo de Pixabay (descargadas con su crédito, --sponsor-photos <carpeta>).
  const sponsorIndex = process.argv.indexOf('--sponsor-photos');
  const sponsorDir = sponsorIndex >= 0 ? process.argv[sponsorIndex + 1] : undefined;
  const sponsorCredits = sponsorDir
    ? (JSON.parse(await readFile(join(sponsorDir, 'credits.json'), 'utf8')) as {
        file: string;
        query: string;
        creator: string | null;
      }[])
    : [];
  const photosOf = (query: string) => sponsorCredits.filter((c) => c.query === query);
  const assetCache = new Map<string, { url: string; thumbUrl: string }>();
  async function sponsorAsset(file: string) {
    if (!assetCache.has(file)) {
      assetCache.set(
        file,
        await images.uploadSponsorAsset(await readFile(join(sponsorDir!, file))),
      );
    }
    return assetCache.get(file)!;
  }
  const credit = (c: { creator: string | null } | undefined) =>
    c ? ` Foto de ejemplo: ${c.creator ?? 'autor desconocido'} vía Pixabay.` : '';

  type DemoProduct = {
    name: string;
    query: string;
    photo: number;
    audience: 'CLIENTS' | 'BARBERSHOPS' | 'ALL';
    price: number;
    offer?: number;
    coupon?: string;
    offerDays?: number;
    detail?: string;
    description: string;
  };
  const sponsorDefs: {
    name: string;
    category: 'COSMETICS' | 'TOOLS' | 'FURNITURE' | 'SUPPLIES' | 'EDUCATION';
    description: string;
    cover: string;
    pkg: string | null;
    audience: 'CLIENTS' | 'BARBERSHOPS' | 'ALL';
    slots: { slot: string; title: string; query: string }[];
    video?: { queries: string[]; caption: string };
    products: DemoProduct[];
  }[] = [
    {
      name: 'Cera Andina',
      category: 'COSMETICS',
      description:
        'Ceras y pomadas para peinar con fijación todo el día. Hechas en Arequipa con ingredientes naturales.',
      cover: 'hair pomade',
      pkg: 'crecimiento',
      audience: 'CLIENTS',
      slots: [
        {
          slot: 'home_banner',
          title: 'Tu fade dura todo el día con Cera Andina',
          query: 'hair wax',
        },
        { slot: 'search_top', title: 'Pomada mate: 25 % menos esta semana', query: 'hair pomade' },
        {
          slot: 'store_featured',
          title: 'Nueva línea mate: peinado natural',
          query: 'hair pomade',
        },
      ],
      video: { queries: ['hair pomade', 'hair wax'], caption: 'Cómo peinar con pomada mate' },
      products: [
        {
          name: 'Pomada mate 100 g',
          query: 'hair pomade',
          photo: 0,
          audience: 'CLIENTS',
          price: 3500,
          offer: 2625,
          coupon: 'CHARLES25',
          offerDays: 10,
          detail: 'Frasco de 100 g',
          description: 'Fijación media, acabado sin brillo. Se lava con agua.',
        },
        {
          name: 'Cera brillo fuerte',
          query: 'hair wax',
          photo: 0,
          audience: 'CLIENTS',
          price: 2800,
          detail: 'Lata de 90 g',
          description: 'Para peinados clásicos y pompadour.',
        },
        {
          name: 'Pomada a base de agua',
          query: 'hair pomade',
          photo: 1,
          audience: 'ALL',
          price: 3200,
          offer: 2700,
          offerDays: 20,
          detail: 'Frasco de 120 g',
          description: 'Brillo medio, no deja residuos. También en presentación para barberías.',
        },
      ],
    },
    {
      name: 'Barba Fuerte',
      category: 'COSMETICS',
      description: 'Aceites y bálsamos para el cuidado de la barba. Aroma a eucalipto y muña.',
      cover: 'beard oil',
      pkg: 'basico',
      audience: 'CLIENTS',
      slots: [
        { slot: 'booking_success', title: 'Después del corte, cuida tu barba', query: 'beard oil' },
      ],
      video: { queries: ['beard oil'], caption: 'Rutina de barba en 30 segundos' },
      products: [
        {
          name: 'Aceite para barba 30 ml',
          query: 'beard oil',
          photo: 0,
          audience: 'CLIENTS',
          price: 4500,
          offer: 3150,
          offerDays: 7,
          detail: 'Gotero de 30 ml',
          description: 'Suaviza y da brillo. Con aceite de argán.',
        },
        {
          name: 'Bálsamo para barba',
          query: 'beard oil',
          photo: 1,
          audience: 'CLIENTS',
          price: 3800,
          detail: 'Lata de 60 g',
          description: 'Peina y controla el frizz.',
        },
        {
          name: 'Kit de barba (aceite + peine)',
          query: 'beard oil',
          photo: 2,
          audience: 'CLIENTS',
          price: 7900,
          offer: 5900,
          coupon: 'BARBA20',
          offerDays: 15,
          description: 'Ideal para regalo.',
        },
      ],
    },
    {
      name: 'Navaja de Oro Pro',
      category: 'TOOLS',
      description:
        'Máquinas, navajas y tijeras profesionales con garantía de un año y servicio técnico en Juliaca.',
      cover: 'hair clipper',
      pkg: 'destacado',
      audience: 'BARBERSHOPS',
      slots: [
        {
          slot: 'shop_dashboard',
          title: 'Renueva tus máquinas: cuotas sin intereses',
          query: 'hair clipper',
        },
        {
          slot: 'store_featured',
          title: 'Máquina inalámbrica Pro: 15 % menos',
          query: 'barber tools',
        },
      ],
      video: {
        queries: ['hair clipper', 'straight razor', 'barber scissors'],
        caption: 'Conoce la nueva máquina inalámbrica',
      },
      products: [
        {
          name: 'Máquina inalámbrica Pro',
          query: 'hair clipper',
          photo: 0,
          audience: 'BARBERSHOPS',
          price: 38000,
          offer: 32300,
          offerDays: 30,
          detail: 'Batería de 4 h',
          description: 'Motor rotativo, cuchillas de acero, base de carga.',
        },
        {
          name: 'Patillera de precisión',
          query: 'hair clipper',
          photo: 1,
          audience: 'BARBERSHOPS',
          price: 22000,
          detail: 'Cuchilla en T',
          description: 'Para contornos y diseños.',
        },
        {
          name: 'Navaja clásica de acero',
          query: 'straight razor',
          photo: 0,
          audience: 'BARBERSHOPS',
          price: 9000,
          offer: 7500,
          coupon: 'NAVAJA15',
          offerDays: 12,
          description: 'Hoja intercambiable, mango de madera.',
        },
        {
          name: 'Tijera de corte 6"',
          query: 'barber scissors',
          photo: 0,
          audience: 'BARBERSHOPS',
          price: 15000,
          detail: 'Acero japonés',
          description: 'Filo de navaja, tornillo de ajuste.',
        },
      ],
    },
    {
      name: 'Sillones Titán',
      category: 'FURNITURE',
      description:
        'Sillones hidráulicos y mobiliario para barberías. Entrega e instalación en Puno.',
      cover: 'barber chair',
      pkg: 'basico',
      audience: 'BARBERSHOPS',
      slots: [
        { slot: 'store_featured', title: 'Sillón hidráulico con 12 cuotas', query: 'barber chair' },
      ],
      products: [
        {
          name: 'Sillón hidráulico clásico',
          query: 'barber chair',
          photo: 0,
          audience: 'BARBERSHOPS',
          price: 189000,
          offer: 169000,
          offerDays: 25,
          description: 'Reclinable, giratorio, tapiz de cuero sintético.',
        },
        {
          name: 'Sillón vintage',
          query: 'barber chair',
          photo: 1,
          audience: 'BARBERSHOPS',
          price: 245000,
          description: 'Estilo clásico americano con reposapiés cromado.',
        },
      ],
    },
    {
      name: 'Insumos Altiplano',
      category: 'SUPPLIES',
      description: 'Shampoo, capas, toallas y secadoras al por mayor y menor.',
      cover: 'shampoo bottle',
      pkg: null,
      audience: 'ALL',
      slots: [],
      products: [
        {
          name: 'Shampoo profesional 1 L',
          query: 'shampoo bottle',
          photo: 0,
          audience: 'ALL',
          price: 3900,
          offer: 2900,
          offerDays: 9,
          detail: 'Botella de 1 L',
          description: 'Para todo tipo de cabello.',
        },
        {
          name: 'Capa de corte impermeable',
          query: 'barber cape',
          photo: 0,
          audience: 'BARBERSHOPS',
          price: 4500,
          description: 'Cierre a presión, tela que no retiene pelo.',
        },
        {
          name: 'Secadora 2200 W',
          query: 'hair dryer',
          photo: 0,
          audience: 'ALL',
          price: 15900,
          description: 'Dos velocidades, aire frío.',
        },
      ],
    },
    {
      name: 'Academia Corte Fino',
      category: 'EDUCATION',
      description: 'Cursos de barbería con certificado: fades, diseños y atención al cliente.',
      cover: 'barber course',
      pkg: 'basico',
      audience: 'BARBERSHOPS',
      slots: [
        {
          slot: 'shop_dashboard',
          title: 'Capacita a tu equipo: curso de fade',
          query: 'barber course',
        },
      ],
      products: [
        {
          name: 'Curso de fade (4 semanas)',
          query: 'barber course',
          photo: 0,
          audience: 'ALL',
          price: 45000,
          offer: 35000,
          coupon: 'FADE100',
          offerDays: 14,
          detail: 'Presencial en Juliaca',
          description: 'Sábados y domingos. Incluye práctica con modelos.',
        },
        {
          name: 'Taller de diseños',
          query: 'barber course',
          photo: 1,
          audience: 'BARBERSHOPS',
          price: 18000,
          detail: '1 día',
          description: 'Líneas, figuras y freestyle.',
        },
      ],
    },
  ];

  /** Video corto de demostración: secuencia de 3 s por foto (1280×720), hecho con ffmpeg. */
  async function slideshow(files: string[]): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'charles-demo-video-'));
    try {
      const out = join(dir, 'out.mp4');
      const inputs = files.flatMap((f) => ['-loop', '1', '-t', '3', '-i', join(sponsorDir!, f)]);
      const scaled = files
        .map(
          (_f, i) =>
            `[${i}:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=25[v${i}]`,
        )
        .join(';');
      const concat = `${files.map((_f, i) => `[v${i}]`).join('')}concat=n=${files.length}:v=1:a=0[out]`;
      execFileSync(
        ffmpegPath!,
        [
          '-y',
          ...inputs,
          '-filter_complex',
          `${scaled};${concat}`,
          '-map',
          '[out]',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          out,
        ],
        { stdio: 'ignore' },
      );
      return await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const storage = app.get<ImageStorage>(IMAGE_STORAGE);
  const videos = app.get(VideosService);

  const packages = new Map((await prisma.sponsorPackage.findMany()).map((p) => [p.code, p]));
  for (const def of sponsorDefs) {
    const cover = photosOf(def.cover)[2] ?? photosOf(def.cover)[0];
    const logo = photosOf(def.cover)[0];
    const sponsor = await prisma.sponsor.create({
      data: {
        name: def.name,
        category: def.category,
        description: def.description,
        websiteUrl: `https://${ascii(def.name)}.example.com`,
        logoUrl: logo ? (await sponsorAsset(logo.file)).thumbUrl : null,
        coverUrl: cover ? (await sponsorAsset(cover.file)).url : null,
        contactEnc: enc.encrypt(
          `contacto@${ascii(def.name)}.example.com`,
          EncryptedField.SPONSOR_CONTACT,
        ),
      },
    });
    for (const [i, item] of def.products.entries()) {
      const photo = photosOf(item.query)[item.photo];
      await prisma.sponsorProduct.create({
        data: {
          sponsorId: sponsor.id,
          name: item.name,
          description: `${item.description}${credit(photo)}`,
          imageUrl: photo ? (await sponsorAsset(photo.file)).url : null,
          actionUrl: `https://${ascii(def.name)}.example.com/producto/${i + 1}`,
          priceText: item.detail ?? null,
          audience: item.audience,
          priceAmount: item.price,
          offerPriceAmount: item.offer ?? null,
          couponCode: item.coupon ?? null,
          offerEndsAt: item.offerDays ? new Date(now + item.offerDays * DAY) : null,
          clickCount: Math.floor(rand() * 60),
          sortOrder: i,
        },
      });
    }
    if (def.pkg) {
      const pkg = packages.get(def.pkg)!;
      const campaign = await prisma.sponsorCampaign.create({
        data: {
          sponsorId: sponsor.id,
          name: `${def.name} — campaña de lanzamiento`,
          startsAt: new Date(now - 5 * DAY),
          endsAt: new Date(now + pkg.durationDays * DAY),
          audience: def.audience,
          status: 'ACTIVE',
          impressionsLimit: pkg.impressionsLimit,
        },
      });
      for (const [i, slot] of def.slots.slice(0, pkg.placementsLimit).entries()) {
        const photo = photosOf(slot.query)[1] ?? photosOf(slot.query)[0];
        await prisma.sponsorPlacement.create({
          data: {
            campaignId: campaign.id,
            slotKey: slot.slot,
            title: slot.title,
            imageUrl: photo ? (await sponsorAsset(photo.file)).url : null,
            actionUrl: `https://${ascii(def.name)}.example.com`,
            priority: def.slots.length - i,
          },
        });
      }
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
    // Video de la marca: se guarda el original y se procesa aquí mismo (sin pasar por la cola).
    const frames = (def.video?.queries ?? []).flatMap((q) => photosOf(q).slice(0, 2));
    if (def.video && frames.length > 0 && storage.enabled) {
      const original = `vid/${randomBytes(16).toString('base64url')}/original`;
      await storage.put(original, await slideshow(frames.map((f) => f.file)), 'video/mp4');
      const video = await prisma.video.create({
        data: {
          sponsorId: sponsor.id,
          uploadedById: admin.id,
          caption: def.video.caption,
          variants: { original },
        },
      });
      await videos.process(video.id);
    }
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

  // ───────────── 15. Comunidad: publicaciones, comentarios, me gusta, seguidores y eventos ─────────────
  const photoFiles = mapping.flatMap((g) => g.images);
  const photoDir: string = photosDir;
  let photoIndex = 0;
  async function postPhoto(uploader: string): Promise<string> {
    const file = photoFiles[photoIndex++ % photoFiles.length]!;
    const variants = await images.storePostPhoto(await readFile(join(photoDir, file)));
    const media = await prisma.postMedia.create({
      data: { uploadedById: uploader, variants },
    });
    return media.id;
  }
  const byKey = (key: string) => shops.find((x) => x.def.key === key)!;
  const shopPosts: {
    key: string;
    type: 'PROMOTION' | 'EVENT' | 'WORK' | 'ANNOUNCEMENT';
    body: string;
    daysAgo: number;
    photos: number;
    event?: { inDays: number; hour: number; address: string; capacity: number | null };
  }[] = [
    {
      key: 'imperial',
      type: 'WORK',
      body: 'Degradado medio con diseño para el fin de semana. ¿Qué te parece? 💈',
      daysAgo: 1,
      photos: 2,
    },
    {
      key: 'imperial',
      type: 'PROMOTION',
      body: 'Martes de fade: 20 % de descuento en todos los degradados. Reserva desde la app.',
      daysAgo: 3,
      photos: 1,
    },
    {
      key: 'fadehouse',
      type: 'EVENT',
      body: 'Taller gratuito de degradados para barberos que empiezan. Cupos limitados.',
      daysAgo: 2,
      photos: 1,
      event: { inDays: 6, hour: 17, address: 'Jr. San Román 320, Juliaca', capacity: 15 },
    },
    {
      key: 'fadehouse',
      type: 'WORK',
      body: 'Undercut con línea marcada. Trabajo de Alex.',
      daysAgo: 5,
      photos: 1,
    },
    {
      key: 'santabarbara',
      type: 'ANNOUNCEMENT',
      body: 'Desde este mes atendemos también los domingos de 10:00 a 13:00.',
      daysAgo: 4,
      photos: 0,
    },
    {
      key: 'navaja',
      type: 'WORK',
      body: 'Clásico con tijera, perfecto para la oficina.',
      daysAgo: 6,
      photos: 1,
    },
    {
      key: 'andino',
      type: 'EVENT',
      body: 'Noche de mullets: cortes a precio especial y música en vivo. ¡Te esperamos!',
      daysAgo: 1,
      photos: 1,
      event: {
        inDays: 3,
        hour: 19,
        address: 'Av. Huancané 890, La Capilla, Juliaca',
        capacity: null,
      },
    },
    {
      key: 'donlucho',
      type: 'PROMOTION',
      body: 'Corte + barba por S/ 30 toda la semana.',
      daysAgo: 2,
      photos: 1,
    },
    {
      key: 'mercedes',
      type: 'ANNOUNCEMENT',
      body: 'Atendemos sin cita de 9:00 a 13:00 y con cita por la tarde.',
      daysAgo: 8,
      photos: 0,
    },
  ];
  const promoOf = new Map<string, string>();
  for (const [id, promo] of shopPromos) promoOf.set(id, promo.id);
  const posts: { id: string; ownerId: string }[] = [];
  for (const sp of shopPosts) {
    const s = byKey(sp.key);
    const createdAt = new Date(now - sp.daysAgo * DAY - Math.floor(rand() * 8) * 3_600_000);
    const mediaIds: string[] = [];
    for (let i = 0; i < sp.photos; i++) mediaIds.push(await postPhoto(s.ownerId));
    const eventStart = sp.event ? limaAt(now, sp.event.inDays, sp.event.hour) : null;
    const post = await prisma.post.create({
      data: {
        type: sp.type,
        barbershopId: s.id,
        createdById: s.ownerId,
        body: sp.body,
        promotionId: sp.type === 'PROMOTION' ? (promoOf.get(s.id) ?? null) : null,
        eventStartsAt: eventStart,
        eventEndsAt: eventStart ? new Date(eventStart.getTime() + 3 * 3_600_000) : null,
        eventAddress: sp.event?.address ?? null,
        eventCapacity: sp.event?.capacity ?? null,
        latitude: s.def.latitude,
        longitude: s.def.longitude,
        pinnedAt: sp.key === 'imperial' && sp.type === 'PROMOTION' ? createdAt : null,
        createdAt,
      },
    });
    for (const [i, id] of mediaIds.entries()) {
      await prisma.postMedia.update({ where: { id }, data: { postId: post.id, sortOrder: i } });
    }
    posts.push({ id: post.id, ownerId: s.ownerId });
  }
  // Publicación de un barbero independiente a su nombre (perfil profesional).
  const yeison = byKey('yeison');
  const yeisonProfile = await prisma.barberProfile.findUniqueOrThrow({
    where: { userId: yeison.ownerId },
  });
  const yeisonPost = await prisma.post.create({
    data: {
      type: 'WORK',
      authorProfileId: yeisonProfile.id,
      createdById: yeison.ownerId,
      body: 'Spiky con textura. Agenda tu cita conmigo 🔥',
      latitude: yeison.def.latitude,
      longitude: yeison.def.longitude,
      createdAt: new Date(now - 2 * DAY),
    },
  });
  const ym = await postPhoto(yeison.ownerId);
  await prisma.postMedia.update({ where: { id: ym }, data: { postId: yeisonPost.id } });
  posts.push({ id: yeisonPost.id, ownerId: yeison.ownerId });

  // Fotos de Comunidad bajadas de Openverse (CC0 / CC BY), solo para la demo y con su crédito.
  const communityIndex = process.argv.indexOf('--community-photos');
  const communityDir = communityIndex >= 0 ? process.argv[communityIndex + 1] : undefined;
  if (communityDir) {
    const credits = JSON.parse(await readFile(join(communityDir, 'credits.json'), 'utf8')) as {
      file: string;
      creator: string | null;
      license: string;
      source: string;
    }[];
    const BODIES: { type: 'WORK' | 'ANNOUNCEMENT' | 'PROMOTION'; text: string }[] = [
      { type: 'WORK', text: 'Degradado limpio para empezar la semana. ¿Te animas?' },
      { type: 'WORK', text: 'Corte clásico con tijera: el que nunca pasa de moda.' },
      { type: 'ANNOUNCEMENT', text: 'Así luce nuestro local: te esperamos con cita o sin cita.' },
      { type: 'WORK', text: 'Perfilado de barba y contorno. Reserva tu turno desde la app.' },
      {
        type: 'PROMOTION',
        text: 'Esta semana: corte + lavado a precio especial reservando por Charles.',
      },
      { type: 'WORK', text: 'Textura arriba y laterales al ras. Pide este estilo.' },
      { type: 'ANNOUNCEMENT', text: 'Renovamos sillones y herramientas para atenderte mejor.' },
      { type: 'WORK', text: 'Fade alto con línea marcada. Trabajo del equipo.' },
    ];
    const authors = shops.filter((s) => s.def.type === 'BARBERSHOP');
    for (const [i, credit] of credits.entries()) {
      const s = authors[i % authors.length]!;
      const b = BODIES[i % BODIES.length]!;
      const variants = await images.storePostPhoto(await readFile(join(communityDir, credit.file)));
      const created = new Date(now - (i % 12) * DAY - (3 + i) * 3_600_000);
      const post = await prisma.post.create({
        data: {
          type: b.type,
          barbershopId: s.id,
          createdById: s.ownerId,
          body: `${b.text}

Foto de ejemplo: ${credit.creator ?? 'autor desconocido'} (${credit.license}) vía ${credit.source}.`,
          promotionId: b.type === 'PROMOTION' ? (promoOf.get(s.id) ?? null) : null,
          latitude: s.def.latitude,
          longitude: s.def.longitude,
          createdAt: created,
        },
      });
      await prisma.postMedia.create({
        data: { postId: post.id, uploadedById: s.ownerId, variants },
      });
      posts.push({ id: post.id, ownerId: s.ownerId });
    }
  }

  // Seguidores, me gusta, guardados y asistencia.
  const COMMENTS = [
    '¡Quedó increíble!',
    '¿Tienen turno para el sábado?',
    'Ahí estaré 🙌',
    '¿Cuánto cuesta?',
    'El mejor de Juliaca.',
    'Me encanta ese degradado.',
  ];
  for (const [ci, c] of clients.entries()) {
    for (const s of shops)
      if (rand() < 0.35)
        await prisma.follow.create({ data: { followerId: c.id, barbershopId: s.id } });
    if (rand() < 0.4)
      await prisma.follow.create({ data: { followerId: c.id, barberProfileId: yeisonProfile.id } });
    for (const p of posts) {
      if (rand() < 0.45) {
        await prisma.postLike.create({ data: { postId: p.id, userId: c.id } });
        await prisma.post.update({ where: { id: p.id }, data: { likeCount: { increment: 1 } } });
      }
      if (rand() < 0.08) await prisma.postSave.create({ data: { postId: p.id, userId: c.id } });
    }
    if (ci < 8) {
      const p = posts[ci % posts.length]!;
      const top = await prisma.postComment.create({
        data: {
          postId: p.id,
          authorId: c.id,
          body: COMMENTS[ci % COMMENTS.length]!,
          createdAt: new Date(now - (ci + 1) * 3_600_000),
        },
      });
      let count = 1;
      if (ci % 2 === 0) {
        await prisma.postComment.create({
          data: {
            postId: p.id,
            authorId: p.ownerId,
            parentId: top.id,
            mentionUserId: c.id,
            body: '¡Gracias! Te esperamos 💈',
            createdAt: new Date(now - ci * 3_600_000),
          },
        });
        await prisma.postComment.update({ where: { id: top.id }, data: { replyCount: 1 } });
        count++;
      }
      await prisma.post.update({
        where: { id: p.id },
        data: { commentCount: { increment: count } },
      });
    }
  }
  const events = await prisma.post.findMany({
    where: { type: 'EVENT' },
    select: { id: true, eventCapacity: true },
  });
  for (const e of events) {
    let going = 0;
    let interested = 0;
    for (const c of clients.slice(0, 12)) {
      const r = rand();
      if (r < 0.35 && (e.eventCapacity === null || going < e.eventCapacity)) {
        await prisma.eventAttendance.create({
          data: { postId: e.id, userId: c.id, status: 'GOING' },
        });
        going++;
      } else if (r < 0.6) {
        await prisma.eventAttendance.create({
          data: { postId: e.id, userId: c.id, status: 'INTERESTED' },
        });
        interested++;
      }
    }
    await prisma.post.update({
      where: { id: e.id },
      data: { goingCount: going, interestedCount: interested },
    });
  }
  // Un reporte abierto para revisar en el panel (Comunidad).
  const reported = await prisma.postComment.create({
    data: {
      postId: posts[1]!.id,
      authorId: clients[20]!.id,
      body: 'Visiten mi página de ofertas, link en mi perfil!!!',
      createdAt: new Date(now - 30 * 60_000),
      reportCount: 2,
    },
  });
  await prisma.post.update({
    where: { id: posts[1]!.id },
    data: { commentCount: { increment: 1 } },
  });
  for (const c of [clients[0]!, clients[1]!]) {
    await prisma.contentReport.create({
      data: {
        reporterId: c.id,
        targetType: 'COMMENT',
        targetId: reported.id,
        reason: 'SPAM',
        note: 'Publicidad',
      },
    });
  }

  // ───────────── 16. Foros: temas, preguntas, respuestas y mejores respuestas ─────────────
  const forumCategories = [
    ['tecnicas-de-corte', 'Técnicas de corte', 'Fades, tijera, navaja y diseños.'],
    ['cuidado-personal', 'Cuidado del cabello y la barba', 'Productos, rutinas y consejos.'],
    ['negocio', 'Negocio de la barbería', 'Precios, clientes, equipo y local.'],
    ['herramientas', 'Herramientas y equipo', 'Máquinas, navajas, sillones y mantenimiento.'],
    ['estilos', 'Estilos y tendencias', '¿Qué corte me queda? Ideas y fotos de referencia.'],
  ] as const;
  const forumCategory = new Map<string, string>();
  for (const [i, [slug, name, description]] of forumCategories.entries()) {
    const c = await prisma.forumCategory.create({
      data: { slug, name, description, sortOrder: i },
    });
    forumCategory.set(slug, c.id);
  }
  const barberUsers = shops.flatMap((x) => x.barbers.map((b) => b.userId));
  const ownerUsers = shops.map((x) => x.ownerId);
  const threads: {
    category: string;
    author: string;
    title: string;
    body: string;
    hoursAgo: number;
    replies: { author: string; body: string; helpful: number }[];
    solution?: number;
    pinned?: boolean;
  }[] = [
    {
      category: 'tecnicas-de-corte',
      author: clients[2]!.id,
      title: '¿Cómo pido un low fade para que no me lo dejen muy alto?',
      body: 'Siempre que pido fade me lo suben casi hasta la coronilla. ¿Qué le tengo que decir al barbero?',
      hoursAgo: 30,
      replies: [
        {
          author: barberUsers[0]!,
          body: 'Pide "low fade, que empiece encima de la oreja" y muéstrale una foto. El número de guarda también ayuda: 0 abajo y 2 arriba es lo clásico.',
          helpful: 9,
        },
        {
          author: barberUsers[3]!,
          body: 'Dile dónde quieres la línea de transición tocándote la cabeza con el dedo. Así no hay confusión.',
          helpful: 4,
        },
        {
          author: clients[5]!.id,
          body: 'A mí me sirvió guardar una foto en el celular y enseñarla antes de empezar.',
          helpful: 2,
        },
      ],
      solution: 0,
    },
    {
      category: 'cuidado-personal',
      author: clients[3]!.id,
      title: '¿Cada cuánto debo usar aceite para la barba?',
      body: 'Me está creciendo la barba y pica bastante. ¿Aceite todos los días o solo a veces?',
      hoursAgo: 52,
      replies: [
        {
          author: barberUsers[1]!,
          body: 'Todos los días después de la ducha, 3 o 4 gotas. El picor de las primeras semanas pasa con hidratación.',
          helpful: 7,
        },
        {
          author: clients[6]!.id,
          body: 'Yo lo uso en la noche y el bálsamo en la mañana para peinarla.',
          helpful: 3,
        },
      ],
      solution: 0,
    },
    {
      category: 'negocio',
      author: ownerUsers[1]!,
      title: '¿Cómo manejan los clientes que no llegan a su cita?',
      body: 'Este mes tuvimos varios no-show los sábados. ¿Cobran adelanto o qué hacen?',
      hoursAgo: 20,
      replies: [
        {
          author: ownerUsers[0]!,
          body: 'Activamos el pago anticipado en la app para los sábados. Bajó muchísimo.',
          helpful: 6,
        },
        {
          author: ownerUsers[2]!,
          body: 'Nosotros usamos la lista de espera: si alguien cancela, la app avisa y el turno se llena solo.',
          helpful: 5,
        },
      ],
    },
    {
      category: 'herramientas',
      author: barberUsers[4]!,
      title: '¿Qué máquina inalámbrica recomiendan que aguante todo el día?',
      body: 'Trabajo 10 horas y la batería de la mía no llega a la tarde.',
      hoursAgo: 9,
      replies: [
        {
          author: barberUsers[2]!,
          body: 'Busca una de motor rotativo con batería de 4 h o más y ten una de respaldo cargando.',
          helpful: 3,
        },
      ],
    },
    {
      category: 'estilos',
      author: clients[7]!.id,
      title: 'Cara redonda: ¿qué corte me favorece?',
      body: 'Tengo la cara bastante redonda y no sé qué pedir. Me gustaría algo moderno.',
      hoursAgo: 4,
      replies: [],
    },
    {
      category: 'tecnicas-de-corte',
      author: ownerUsers[0]!,
      title: 'Normas del foro: respeto y nada de publicidad',
      body: 'Este espacio es para ayudarnos entre todos. Nada de insultos ni venta de productos; para eso está la Tienda. Reporta lo que no cumpla las normas.',
      hoursAgo: 200,
      replies: [],
      pinned: true,
    },
  ];
  for (const t of threads) {
    const created = new Date(now - t.hoursAgo * 3_600_000);
    const thread = await prisma.forumThread.create({
      data: {
        categoryId: forumCategory.get(t.category)!,
        authorId: t.author,
        title: t.title,
        body: t.body,
        createdAt: created,
        lastActivityAt: created,
        replyCount: t.replies.length,
        pinnedAt: t.pinned ? created : null,
        lockedAt: t.pinned ? created : null,
      },
    });
    let last = created;
    const replyIds: string[] = [];
    for (const [i, r] of t.replies.entries()) {
      last = new Date(created.getTime() + (i + 1) * 47 * 60_000);
      const reply = await prisma.forumReply.create({
        data: {
          threadId: thread.id,
          authorId: r.author,
          body: r.body,
          createdAt: last,
          helpfulCount: Math.min(r.helpful, clients.length),
        },
      });
      replyIds.push(reply.id);
      const voters = clients.filter((c) => c.id !== r.author).slice(0, r.helpful);
      await prisma.forumReplyVote.createMany({
        data: voters.map((c) => ({ replyId: reply.id, userId: c.id })),
      });
    }
    await prisma.forumThread.update({
      where: { id: thread.id },
      data: {
        lastActivityAt: last,
        solutionReplyId: t.solution !== undefined ? replyIds[t.solution]! : null,
      },
    });
    await prisma.forumCategory.update({
      where: { id: forumCategory.get(t.category)! },
      data: { threadCount: { increment: 1 } },
    });
  }
  // Un hilo con publicidad encubierta, reportado: queda para revisar en el panel.
  const spam = await prisma.forumThread.create({
    data: {
      categoryId: forumCategory.get('herramientas')!,
      authorId: clients[8]!.id,
      title: 'Vendo máquinas baratas, escríbeme al privado',
      body: 'Precios de remate, solo por hoy.',
      lastActivityAt: new Date(now - 2 * 3_600_000),
      createdAt: new Date(now - 2 * 3_600_000),
      reportCount: 2,
    },
  });
  await prisma.forumCategory.update({
    where: { id: forumCategory.get('herramientas')! },
    data: { threadCount: { increment: 1 } },
  });
  for (const c of [clients[0]!, clients[1]!]) {
    await prisma.contentReport.create({
      data: {
        reporterId: c.id,
        targetType: 'FORUM_THREAD',
        targetId: spam.id,
        reason: 'SPAM',
        note: 'Publicidad en el foro',
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
    prisma.post.count(),
    prisma.sponsor.count(),
    prisma.sponsorProduct.count(),
    prisma.video.count({ where: { sponsorId: { not: null }, status: 'READY' } }),
    prisma.forumThread.count(),
    prisma.forumReply.count(),
  ]);
  console.warn(
    `Listo: ${counts[0]} barberías, ${counts[1]} cuentas, ${counts[2]} reservas, ${counts[3]} valoraciones, ` +
      `${counts[4]} fotos, ${counts[5]} ventas, ${counts[6]} clientes del panel, ${counts[7]} membresías, ` +
      `${counts[8]} publicaciones, ${counts[9]} marcas con ${counts[10]} productos y ${counts[11]} videos, ${counts[12]} hilos del foro con ${counts[13]} respuestas.`,
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
