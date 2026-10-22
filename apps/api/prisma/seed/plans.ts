import type { PrismaClient } from '../../src/generated/prisma/client';

/**
 * Planes y paquetes **de demostración** (Fase 15): los valores se editan desde el panel ADMIN.
 * Idempotente: solo crea lo que no existe (por código); nunca modifica ni borra.
 */

type Values = Record<string, number | null>;

interface PlanSeed {
  code: string;
  name: string;
  description: string;
  audience: 'BARBERSHOP' | 'BARBER';
  priceMonthly: number;
  priceYearly: number | null;
  trialDays: number;
  commissionBp: number | null;
  sortOrder: number;
  isDefault: boolean;
  values: Values;
}

const SHOP_FREE: Values = {
  barbers: 2,
  gallery_photos: 20,
  featured_days_month: 0,
  messages_month: 50,
  crm_clients: 100,
  local_sales_month: 30,
  promotions: 0,
  client_ranking: 0,
  reports_full: 0,
  reports_export: 0,
  memberships: 0,
  verified_badge: 0,
  priority_support: 0,
};

export const DEMO_PLANS: PlanSeed[] = [
  {
    code: 'gratis',
    name: 'Gratis',
    description: 'Para empezar: agenda, reservas y pagos en línea.',
    audience: 'BARBERSHOP',
    priceMonthly: 0,
    priceYearly: null,
    trialDays: 0,
    commissionBp: 800,
    sortOrder: 0,
    isDefault: true,
    values: SHOP_FREE,
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Para barberías en crecimiento: más barberos, promociones y ranking de clientes.',
    audience: 'BARBERSHOP',
    priceMonthly: 5900,
    priceYearly: 59000,
    trialDays: 14,
    commissionBp: 500,
    sortOrder: 1,
    isDefault: false,
    values: {
      barbers: 6,
      gallery_photos: 150,
      featured_days_month: 3,
      messages_month: 500,
      crm_clients: 1000,
      local_sales_month: 500,
      promotions: 1,
      client_ranking: 1,
      reports_full: 1,
      reports_export: 0,
      memberships: 0,
      verified_badge: 1,
      priority_support: 0,
    },
  },
  {
    code: 'premium',
    name: 'Premium',
    description: 'Todo incluido: membresías, exportación de reportes y soporte prioritario.',
    audience: 'BARBERSHOP',
    priceMonthly: 12900,
    priceYearly: 129000,
    trialDays: 14,
    commissionBp: 300,
    sortOrder: 2,
    isDefault: false,
    values: {
      barbers: null,
      gallery_photos: null,
      featured_days_month: 10,
      messages_month: null,
      crm_clients: null,
      local_sales_month: null,
      promotions: 1,
      client_ranking: 1,
      reports_full: 1,
      reports_export: 1,
      memberships: 1,
      verified_badge: 1,
      priority_support: 1,
    },
  },
  {
    code: 'independiente_gratis',
    name: 'Independiente Gratis',
    description: 'Para el barbero independiente que empieza.',
    audience: 'BARBER',
    priceMonthly: 0,
    priceYearly: null,
    trialDays: 0,
    commissionBp: 800,
    sortOrder: 0,
    isDefault: true,
    values: { ...SHOP_FREE, barbers: 1 },
  },
  {
    code: 'independiente',
    name: 'Barbero independiente',
    description: 'Agenda propia, portafolio destacado, promociones y ranking de clientes.',
    audience: 'BARBER',
    priceMonthly: 2500,
    priceYearly: 25000,
    trialDays: 14,
    commissionBp: 500,
    sortOrder: 1,
    isDefault: false,
    values: {
      barbers: 1,
      gallery_photos: 100,
      featured_days_month: 3,
      messages_month: 300,
      crm_clients: 500,
      local_sales_month: 300,
      promotions: 1,
      client_ranking: 1,
      reports_full: 1,
      reports_export: 0,
      memberships: 0,
      verified_badge: 1,
      priority_support: 0,
    },
  },
];

export const DEMO_SPONSOR_PACKAGES = [
  {
    code: 'basico',
    name: 'Básico',
    description: 'Un anuncio por 30 días.',
    priceAmount: 50_000,
    impressionsLimit: 50_000,
    placementsLimit: 1,
    durationDays: 30,
    sortOrder: 0,
  },
  {
    code: 'crecimiento',
    name: 'Crecimiento',
    description: 'Hasta 3 anuncios por 30 días.',
    priceAmount: 150_000,
    impressionsLimit: 200_000,
    placementsLimit: 3,
    durationDays: 30,
    sortOrder: 1,
  },
  {
    code: 'destacado',
    name: 'Destacado',
    description: 'Hasta 6 anuncios por 60 días, sin tope de impresiones.',
    priceAmount: 400_000,
    impressionsLimit: null,
    placementsLimit: 6,
    durationDays: 60,
    sortOrder: 2,
  },
];

export async function seedDemoPlans(
  prisma: PrismaClient,
): Promise<{ plans: number; packages: number }> {
  let plans = 0;
  for (const p of DEMO_PLANS) {
    const exists = await prisma.plan.findUnique({ where: { code: p.code } });
    if (exists) continue;
    // Un solo plan por defecto por público: si ya hay otro, este no lo reemplaza.
    const otherDefault = p.isDefault
      ? await prisma.plan.count({ where: { audience: p.audience, isDefault: true } })
      : 0;
    await prisma.plan.create({
      data: {
        code: p.code,
        name: p.name,
        description: p.description,
        audience: p.audience,
        priceMonthly: p.priceMonthly,
        priceYearly: p.priceYearly,
        trialDays: p.trialDays,
        commissionBp: p.commissionBp,
        sortOrder: p.sortOrder,
        isDefault: p.isDefault && otherDefault === 0,
        entitlements: { create: Object.entries(p.values).map(([key, value]) => ({ key, value })) },
      },
    });
    plans++;
  }
  let packages = 0;
  for (const pkg of DEMO_SPONSOR_PACKAGES) {
    const exists = await prisma.sponsorPackage.findUnique({ where: { code: pkg.code } });
    if (exists) continue;
    await prisma.sponsorPackage.create({ data: pkg });
    packages++;
  }
  return { plans, packages };
}
