import { BlindIndexKind, EncryptedField } from '../../src/common/crypto/encryption-contexts';
import type { EncryptionService } from '../../src/common/crypto/encryption.service';
import { PasswordHasher } from '../../src/common/crypto/password-hasher';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import { type ServiceCategoryKey, seedServiceCategories, seedServiceStyles } from './categories';

/**
 * Datos de prueba ficticios (CLAUDE.md §1.5): correos @example.com, teléfonos y documentos
 * inventados, sin secretos. Idempotente: IDs fijos y `upsert`, nunca borra datos.
 */

export const SEED_PASSWORD_MIN_LENGTH = 12;

/** UUID v7 válido y determinista para los registros del seed. */
export function seedId(n: number): string {
  return `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

const time = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);
const MONDAY_TO_SATURDAY = [1, 2, 3, 4, 5, 6];
const CURRENCY = 'PEN';

interface SeedUser {
  id: string;
  email: string;
  fullName: string;
  phone: string;
  document: string;
  birthDate: string;
  roles: ('CLIENT' | 'BARBER' | 'OWNER' | 'SUPPORT')[];
}

export const SEED_USERS = {
  client: {
    id: seedId(1),
    email: 'cliente.demo@example.com',
    fullName: 'Cliente Demo',
    phone: '+51 900 000 001',
    document: 'DEMO-0001',
    birthDate: '1990-01-01',
    roles: ['CLIENT'],
  },
  owner: {
    id: seedId(2),
    email: 'responsable.demo@example.com',
    fullName: 'Responsable Demo',
    phone: '+51 900 000 002',
    document: 'DEMO-0002',
    birthDate: '1985-05-15',
    roles: ['OWNER', 'BARBER'],
  },
  barber: {
    id: seedId(3),
    email: 'barbero.demo@example.com',
    fullName: 'Barbero Demo',
    phone: '+51 900 000 003',
    document: 'DEMO-0003',
    birthDate: '1995-09-30',
    roles: ['BARBER'],
  },
  support: {
    id: seedId(4),
    email: 'soporte.demo@example.com',
    fullName: 'Soporte Demo',
    phone: '+51 900 000 004',
    document: 'DEMO-0004',
    birthDate: '1992-03-20',
    roles: ['SUPPORT'],
  },
} satisfies Record<string, SeedUser>;

const BARBERSHOPS = [
  {
    id: seedId(101),
    name: 'Barbería Demo Miraflores',
    address: 'Av. Ejemplo 123, Miraflores, Lima',
    latitude: -12.1211,
    longitude: -77.0297,
  },
  {
    id: seedId(102),
    name: 'Barbería Demo San Isidro',
    address: 'Calle Ficticia 456, San Isidro, Lima',
    latitude: -12.0977,
    longitude: -77.0365,
  },
];

const BARBERS = [
  {
    id: seedId(201),
    barbershopId: seedId(101),
    userId: SEED_USERS.owner.id,
    displayName: 'Responsable Demo',
    phone: '+51 900 000 002',
  },
  {
    id: seedId(202),
    barbershopId: seedId(101),
    userId: SEED_USERS.barber.id,
    displayName: 'Barbero Demo',
    phone: '+51 900 000 003',
  },
  {
    id: seedId(203),
    barbershopId: seedId(102),
    userId: null,
    displayName: 'Barbero Invitado',
    phone: null,
  },
];

const SERVICE_TEMPLATES: {
  name: string;
  description: string;
  priceAmount: number;
  durationMinutes: number;
  category: ServiceCategoryKey;
}[] = [
  {
    name: 'Corte clásico',
    description: 'Corte con tijera y máquina.',
    priceAmount: 2500,
    durationMinutes: 30,
    category: 'haircut',
  },
  {
    name: 'Corte y barba',
    description: 'Corte completo y perfilado de barba.',
    priceAmount: 4000,
    durationMinutes: 45,
    category: 'haircut_beard',
  },
  {
    name: 'Afeitado',
    description: 'Afeitado con toalla caliente.',
    priceAmount: 2000,
    durationMinutes: 20,
    category: 'shave',
  },
];

/**
 * Valores iniciales de `app_settings` (CLAUDE.md §4.1). Las políticas pendientes (§4.2)
 * se siembran con JSON `null` hasta que se definan. Si la clave ya existe, no se sobrescribe.
 */
/** DNI ficticio del responsable de las barberías de prueba. */
const SEED_OWNER_DNI = '40000001';

export const SEED_SETTINGS: {
  key: string;
  value: Prisma.InputJsonValue | null;
  description: string;
}[] = [
  {
    key: 'booking.pending_payment_ttl_minutes',
    value: 10,
    description:
      'Minutos que una reserva PENDING_PAYMENT bloquea el horario antes de pasar a EXPIRED.',
  },
  {
    key: 'availability.slot_interval_minutes',
    value: 15,
    description: 'Intervalo entre turnos ofrecidos, en minutos.',
  },
  {
    key: 'availability.min_lead_time_minutes',
    value: 0,
    description: 'Anticipación mínima para reservar, en minutos.',
  },
  {
    key: 'account_deletion.grace_days',
    value: 30,
    description:
      'Días entre la solicitud de eliminación de cuenta y su ejecución (se puede cancelar en ese plazo).',
  },
  {
    key: 'account_deletion.email_block_days',
    value: 365,
    description:
      'Días que el correo de una cuenta deshabilitada por soporte y luego eliminada no puede volver a registrarse.',
  },
  {
    key: 'account_deletion.legal_retention_days',
    value: null,
    description:
      'PENDIENTE (asesor legal): plazo de conservación de pagos, reembolsos y reservas anonimizados tras eliminar una cuenta.',
  },
  {
    key: 'legal.terms_url',
    // Provisional: reemplazar por la URL publicada de los términos (CLAUDE.md §4.2).
    value: 'https://charles.example/terminos',
    description:
      'URL pública de los términos y condiciones (https). La app la abre al registrarse.',
  },
  {
    key: 'legal.privacy_url',
    // Provisional: reemplazar por la URL publicada de la política de privacidad.
    value: 'https://charles.example/privacidad',
    description: 'URL pública de la política de privacidad (https).',
  },
  {
    key: 'legal.terms_version',
    // Valor provisional: reemplazar por la versión publicada de los términos (no está definida).
    value: 'borrador-2026-10',
    description:
      'Versión vigente de los términos y condiciones. El registro exige aceptar exactamente esta versión.',
  },
  {
    key: 'auth.lockout.account_max_failures',
    value: 5,
    description: 'Fallos de acceso por cuenta antes del bloqueo progresivo (1, 5 y 15 min).',
  },
  {
    key: 'auth.lockout.ip_max_failures',
    value: 20,
    description: 'Fallos de acceso por IP antes del bloqueo progresivo (mayor: redes compartidas).',
  },
  {
    key: 'barbershops.require_photo',
    value: false,
    description: 'true: para enviar una barbería a revisión se exige la portada (foto del local).',
  },
  {
    key: 'images.gallery_max_per_barber',
    value: 60,
    description: 'Máximo de fotos en la galería de cada barbero.',
  },
  {
    key: 'images.pinned_max_per_barber',
    value: 6,
    description: 'Máximo de fotos destacadas (fijadas) por barbero.',
  },
  {
    key: 'images.report_hide_threshold',
    value: 3,
    description:
      'Reportes abiertos con los que una foto se oculta sola hasta que soporte la revise.',
  },
  {
    key: 'images.upload_rate_limit_per_minute',
    value: 20,
    description: 'Subidas de imágenes por cuenta y minuto (además del límite global por IP).',
  },
  {
    key: 'barbershops.require_review',
    value: true,
    description:
      'true: las barberías nuevas quedan en PENDING_REVIEW hasta que soporte las apruebe.',
  },
  {
    key: 'barbershops.invitation_ttl_minutes',
    value: 2880,
    description:
      'Vigencia del código de invitación a responsables y barberos, en minutos (2880 = 48 h).',
  },
  {
    key: 'availability.booking_horizon_days',
    value: 30,
    description:
      'Días hacia adelante en que se puede reservar (y límite de "siguiente disponibilidad").',
  },
  {
    key: 'availability.now_window_minutes',
    value: 30,
    description: '"Disponible ahora": hay un turno que empieza dentro de estos minutos.',
  },
  {
    key: 'search.default_radius_km',
    value: 5,
    description: 'Radio de búsqueda por defecto, en km (si el cliente no indica uno).',
  },
  {
    key: 'search.max_radius_km',
    value: 25,
    description: 'Radio máximo de búsqueda, en km. Un radio mayor se recorta a este valor.',
  },
  {
    key: 'search.default_page_size',
    value: 20,
    description: 'Resultados por página de búsqueda si no se indica limit.',
  },
  {
    key: 'search.max_page_size',
    value: 50,
    description: 'Tope de resultados por página de búsqueda.',
  },
  {
    key: 'search.max_candidates',
    value: 200,
    description:
      'Con filtros de disponibilidad, máximo de barberías evaluadas por petición de búsqueda.',
  },
  {
    key: 'search.rate_limit_per_minute',
    value: 60,
    description: 'Peticiones de búsqueda por minuto e IP.',
  },
  {
    key: 'booking.max_pending_per_client',
    value: 2,
    description:
      'Máximo de reservas PENDING_PAYMENT vigentes por cliente (evita acaparar turnos sin pagar).',
  },
  {
    key: 'booking.rate_limit_per_minute',
    value: 20,
    description: 'Peticiones por minuto y por cliente para crear reservas.',
  },
  {
    key: 'payments.provider',
    value: 'FAKE',
    description: 'Proveedor de pagos activo. Izipay se integra en la Fase 8 (ADR 0002).',
  },
  { key: 'payments.methods', value: null, description: 'PENDIENTE (§4.2): medios de pago.' },
  {
    key: 'refunds.full_min_minutes',
    value: 300,
    description: 'El cliente cancela con esta anticipación (minutos) o más: devolución total.',
  },
  {
    key: 'refunds.partial_min_minutes',
    value: 120,
    description:
      'El cliente cancela con esta anticipación o más (y menos que la total): devolución parcial.',
  },
  {
    key: 'refunds.partial_percent',
    value: 50,
    description: 'Porcentaje de la devolución parcial (redondeo hacia abajo al céntimo).',
  },
  {
    key: 'barbershops.unjustified_cancellations_limit',
    value: 3,
    description:
      'Cancelaciones injustificadas de la barbería dentro de la ventana que la pasan a SUSPENDED.',
  },
  {
    key: 'barbershops.unjustified_cancellations_window_days',
    value: 30,
    description: 'Ventana, en días, para contar las cancelaciones injustificadas de la barbería.',
  },
  {
    key: 'booking.no_show_after_minutes',
    value: 15,
    description: 'Minutos después del inicio desde los que se puede marcar una inasistencia.',
  },
  {
    key: 'booking.no_show_window_hours',
    value: 24,
    description: 'Horas después del inicio hasta las que se puede marcar una inasistencia.',
  },
  {
    key: 'booking.attendance_auto_close_hours',
    value: 24,
    description:
      'Horas tras el inicio: hasta entonces se marca la asistencia; después, las CONFIRMED sin marcar se cierran como ATTENDED.',
  },
  {
    key: 'booking.attendance_correction_hours',
    value: 48,
    description:
      'Horas tras el inicio en las que el responsable puede corregir ATTENDED ↔ NO_SHOW (con motivo).',
  },
  {
    key: 'reviews.window_days',
    value: 14,
    description:
      'Días desde que la reserva queda ATTENDED para valorarla (y para su única edición).',
  },
  {
    key: 'reviews.report_threshold',
    value: 3,
    description:
      'Reportes distintos con los que una valoración o respuesta pasa a UNDER_REVIEW (sigue visible).',
  },
  {
    key: 'reviews.rate_limit_per_minute',
    value: 10,
    description: 'Valoraciones y reportes que una misma cuenta puede crear por minuto.',
  },
  {
    key: 'support.ticket_reopen_days',
    value: 7,
    description: 'Días tras resolver un ticket en que el usuario lo reabre respondiendo.',
  },
  {
    key: 'support.ticket_auto_close_days',
    value: 7,
    description: 'Días tras resolver un ticket en que se cierra solo si nadie responde.',
  },
  {
    key: 'support.max_open_tickets_per_user',
    value: 5,
    description: 'Tickets abiertos (OPEN o IN_PROGRESS) que una cuenta puede tener a la vez.',
  },
  {
    key: 'support.suspension_keep_hours',
    value: 48,
    description:
      'Al suspender una barbería con la opción por defecto, se mantienen las reservas de estas próximas horas y se cancelan las demás.',
  },
  {
    key: 'notifications.reminder_hours',
    value: [24, 2],
    description:
      'Horas antes del inicio en que se envían los recordatorios. Si caen en el horario silencioso, se adelantan.',
  },
  {
    key: 'notifications.quiet_start',
    value: '22:00',
    description: 'Inicio del horario silencioso (hora local de la barbería): sin push no urgentes.',
  },
  {
    key: 'notifications.quiet_end',
    value: '08:00',
    description: 'Fin del horario silencioso (hora local de la barbería).',
  },
  {
    key: 'notifications.retention_days',
    value: 90,
    description: 'Días que se conservan los avisos de la bandeja.',
  },
  {
    key: 'notifications.max_devices_per_user',
    value: 10,
    description: 'Dispositivos con push por cuenta; al pasarse, se borran los menos usados.',
  },
  {
    key: 'payments.webhook_rate_limit_per_minute',
    value: 600,
    description:
      'Avisos (webhooks) con firma válida por minuto y por proveedor. No depende de la IP.',
  },
  {
    key: 'payments.pending_check_interval_minutes',
    value: 2,
    description:
      'Cada cuántos minutos se consultan a la pasarela los pagos iniciados aún pendientes.',
  },
  {
    key: 'fees.percent_bp',
    value: 0,
    description:
      'Comisión de Charles: porcentaje del servicio en puntos básicos (500 = 5 %). 0 = sin porcentaje.',
  },
  {
    key: 'fees.fixed_amount',
    value: 0,
    description: 'Comisión de Charles: monto fijo por reserva, en céntimos (50 = S/ 0,50).',
  },
  {
    key: 'fees.payer',
    value: 'BARBERSHOP',
    description:
      'Quién paga la comisión: BARBERSHOP (se descuenta a la barbería) o CLIENT (se suma al precio).',
  },
  {
    key: 'payments.payout_policy',
    value: null,
    description: 'PENDIENTE (§4.2): cuándo recibe el dinero la barbería.',
  },
  {
    key: 'payments.no_show_policy',
    value: null,
    description: 'PENDIENTE (§4.2): tratamiento del pago ante un no-show.',
  },
];

export interface SeedDeps {
  prisma: PrismaClient;
  encryption: EncryptionService;
  password: string;
  jsonNull: typeof Prisma.JsonNull;
}

export async function seed({ prisma, encryption, password, jsonNull }: SeedDeps): Promise<void> {
  if (password.length < SEED_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `SEED_USER_PASSWORD debe tener al menos ${SEED_PASSWORD_MIN_LENGTH} caracteres.`,
    );
  }
  const passwordHash = await PasswordHasher.hash(password);
  await seedServiceCategories(prisma);
  await seedServiceStyles(prisma);
  const categoryIds = new Map(
    (await prisma.serviceCategory.findMany({ select: { id: true, key: true } })).map((c) => [
      c.key,
      c.id,
    ]),
  );

  for (const user of Object.values(SEED_USERS)) {
    await prisma.user.upsert({
      where: { id: user.id },
      update: {},
      create: {
        id: user.id,
        emailEnc: encryption.encrypt(user.email, EncryptedField.USER_EMAIL),
        emailHash: encryption.blindIndex(user.email, BlindIndexKind.EMAIL),
        passwordHash,
        fullName: user.fullName,
        phoneEnc: encryption.encrypt(user.phone, EncryptedField.USER_PHONE),
        phoneHash: encryption.blindIndex(user.phone, BlindIndexKind.PHONE),
        documentNumberEnc: encryption.encrypt(user.document, EncryptedField.USER_DOCUMENT_NUMBER),
        documentHash: encryption.blindIndex(user.document, BlindIndexKind.DOCUMENT),
        birthDateEnc: encryption.encrypt(user.birthDate, EncryptedField.USER_BIRTH_DATE),
        termsAcceptedAt: new Date(),
        termsVersion: 'seed',
        // Sin adultDeclaredAt: la declaración de mayoría de edad no se inventa (ADR 0003).
        emailVerifiedAt: new Date(),
      },
    });
    // Correo verificado solo para estos usuarios de prueba (autorizado), para usarlos al reservar.
    await prisma.user.updateMany({
      where: { id: user.id, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    for (const role of user.roles) {
      await prisma.userRole.upsert({
        where: { userId_role: { userId: user.id, role } },
        update: {},
        create: { userId: user.id, role },
      });
    }
  }

  let hourId = 1000;
  let scheduleId = 2000;
  for (const [index, shop] of BARBERSHOPS.entries()) {
    await prisma.barbershop.upsert({
      where: { id: shop.id },
      update: {},
      create: {
        ...shop,
        timezone: 'America/Lima',
        phone: '+51 1 000 0000',
        // Aprobadas: el seed no pasa por la revisión previa (barbershops.require_review).
        status: 'OPEN',
        ownerDocumentType: 'DNI',
        ownerDocumentEnc: encryption.encrypt(
          SEED_OWNER_DNI,
          EncryptedField.BARBERSHOP_OWNER_DOCUMENT,
        ),
        ownerDocumentHash: encryption.blindIndex(SEED_OWNER_DNI, BlindIndexKind.DOCUMENT),
      },
    });
    await prisma.barbershopMember.upsert({
      where: { barbershopId_userId: { barbershopId: shop.id, userId: SEED_USERS.owner.id } },
      update: {},
      create: { barbershopId: shop.id, userId: SEED_USERS.owner.id, role: 'OWNER' },
    });
    for (const day of MONDAY_TO_SATURDAY) {
      const id = seedId(hourId++);
      await prisma.businessHour.upsert({
        where: { id },
        update: {},
        create: {
          id,
          barbershopId: shop.id,
          dayOfWeek: day,
          openTime: time('09:00'),
          closeTime: time('20:00'),
        },
      });
    }
    for (const [i, { category, ...template }] of SERVICE_TEMPLATES.entries()) {
      const id = seedId(301 + index * SERVICE_TEMPLATES.length + i);
      const categoryId = categoryIds.get(category);
      if (!categoryId) throw new Error(`Falta la categoría ${category}`);
      await prisma.service.upsert({
        where: { id },
        update: {},
        create: { id, barbershopId: shop.id, currency: CURRENCY, categoryId, ...template },
      });
    }
  }

  for (const barber of BARBERS) {
    await prisma.barber.upsert({
      where: { id: barber.id },
      update: {},
      create: {
        id: barber.id,
        barbershopId: barber.barbershopId,
        userId: barber.userId,
        displayName: barber.displayName,
        phoneEnc: encryption.encryptNullable(barber.phone, EncryptedField.BARBER_PHONE),
      },
    });
    const services = await prisma.service.findMany({
      where: { barbershopId: barber.barbershopId },
      select: { id: true },
    });
    for (const service of services) {
      await prisma.barberService.upsert({
        where: { barberId_serviceId: { barberId: barber.id, serviceId: service.id } },
        update: {},
        create: { barberId: barber.id, serviceId: service.id },
      });
    }
    // Turno partido con descanso de 13:00 a 14:00.
    for (const day of MONDAY_TO_SATURDAY) {
      for (const [start, end] of [
        ['09:00', '13:00'],
        ['14:00', '20:00'],
      ] as const) {
        const id = seedId(scheduleId++);
        await prisma.barberSchedule.upsert({
          where: { id },
          update: {},
          create: {
            id,
            barberId: barber.id,
            dayOfWeek: day,
            startTime: time(start),
            endTime: time(end),
          },
        });
      }
    }
  }

  for (const setting of SEED_SETTINGS) {
    await prisma.appSetting.upsert({
      where: { key: setting.key },
      update: {},
      create: {
        key: setting.key,
        value: setting.value === null ? jsonNull : setting.value,
        description: setting.description,
      },
    });
  }
}
