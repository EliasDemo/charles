import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { SettingKey } from '../settings/settings.service';
import type { StaffActor } from './admin-access';

/** Esquema de un ajuste editable. Los rangos siguen lo que cada lector acepta. */
export type SettingSchema =
  | { type: 'integer'; min: number; max: number; multipleOf?: number }
  | { type: 'boolean' }
  | { type: 'integerList'; min: number; max: number; minItems: number; maxItems: number }
  | { type: 'string'; minLength: number; maxLength: number; pattern?: RegExp };

interface SettingRule {
  schema?: SettingSchema;
  /** Solo lectura: seguridad, pagos sensibles y decisiones de negocio pendientes. */
  readOnly?: string;
}

const int = (min: number, max: number, multipleOf?: number): SettingRule => ({
  schema: { type: 'integer', min, max, ...(multipleOf ? { multipleOf } : {}) },
});
const readOnly = (why: string): SettingRule => ({ readOnly: why });

const HH_MM: SettingSchema = {
  type: 'string',
  minLength: 5,
  maxLength: 5,
  pattern: /^([01]\d|2[0-3]):[0-5]\d$/,
};

const HTTPS_URL: SettingSchema = {
  type: 'string',
  minLength: 12,
  maxLength: 300,
  pattern: /^https:\/\/[^\s]+$/,
};

const SECURITY = 'Ajuste de seguridad: se cambia por despliegue, no desde el panel.';
const PAYMENTS = 'Ajuste de pagos sensible: se cambia por despliegue, no desde el panel.';
const PENDING = 'Decisión de negocio pendiente (CLAUDE.md §4.2).';

/**
 * Registro de ajustes de `app_settings` (Fase 12). Cada clave editable tiene su esquema y rango;
 * un valor fuera de rango se rechaza. Una clave que no está aquí no se puede editar.
 */
export const SETTING_RULES: Readonly<Record<string, SettingRule>> = {
  [SettingKey.TERMS_VERSION]: {
    schema: { type: 'string', minLength: 1, maxLength: 20, pattern: /^[0-9A-Za-z._-]+$/ },
  },
  [SettingKey.TERMS_URL]: { schema: HTTPS_URL },
  [SettingKey.ACCOUNT_DELETION_GRACE_DAYS]: int(7, 90),
  [SettingKey.ACCOUNT_DELETION_EMAIL_BLOCK_DAYS]: int(1, 1_095),
  [SettingKey.ACCOUNT_DELETION_LEGAL_RETENTION_DAYS]: readOnly(PENDING),
  [SettingKey.PRIVACY_URL]: { schema: HTTPS_URL },
  [SettingKey.IMAGES_GALLERY_MAX]: int(1, 200),
  [SettingKey.IMAGES_PINNED_MAX]: int(1, 20),
  [SettingKey.IMAGES_REPORT_HIDE_THRESHOLD]: int(1, 20),
  [SettingKey.IMAGES_UPLOAD_RATE_LIMIT_PER_MINUTE]: int(1, 120),
  [SettingKey.LOCKOUT_ACCOUNT_MAX_FAILURES]: readOnly(SECURITY),
  [SettingKey.LOCKOUT_IP_MAX_FAILURES]: readOnly(SECURITY),
  [SettingKey.BARBERSHOPS_REQUIRE_REVIEW]: { schema: { type: 'boolean' } },
  [SettingKey.BARBERSHOPS_REQUIRE_PHOTO]: { schema: { type: 'boolean' } },
  [SettingKey.INVITATION_TTL_MINUTES]: int(5, 10_080),
  [SettingKey.SLOT_INTERVAL_MINUTES]: int(5, 60, 5),
  [SettingKey.MIN_LEAD_TIME_MINUTES]: int(0, 1_440),
  [SettingKey.BOOKING_HORIZON_DAYS]: int(1, 365),
  [SettingKey.NOW_WINDOW_MINUTES]: int(5, 720),
  [SettingKey.PENDING_PAYMENT_TTL_MINUTES]: int(5, 60),
  [SettingKey.SEARCH_DEFAULT_RADIUS_KM]: int(1, 25),
  [SettingKey.SEARCH_MAX_RADIUS_KM]: int(1, 100),
  [SettingKey.SEARCH_DEFAULT_PAGE_SIZE]: int(1, 100),
  [SettingKey.SEARCH_MAX_PAGE_SIZE]: int(1, 100),
  [SettingKey.SEARCH_MAX_CANDIDATES]: int(10, 1_000),
  [SettingKey.SEARCH_RATE_LIMIT_PER_MINUTE]: int(1, 600),
  [SettingKey.BOOKING_MAX_PENDING_PER_CLIENT]: int(1, 10),
  [SettingKey.BOOKING_RATE_LIMIT_PER_MINUTE]: int(1, 600),
  [SettingKey.REFUND_FULL_MIN_MINUTES]: int(1, 10_080),
  [SettingKey.REFUND_PARTIAL_MIN_MINUTES]: int(1, 10_080),
  [SettingKey.REFUND_PARTIAL_PERCENT]: int(0, 100),
  [SettingKey.UNJUSTIFIED_CANCELLATIONS_LIMIT]: int(1, 50),
  [SettingKey.UNJUSTIFIED_CANCELLATIONS_WINDOW_DAYS]: int(1, 365),
  [SettingKey.NO_SHOW_AFTER_MINUTES]: int(1, 240),
  [SettingKey.NO_SHOW_WINDOW_HOURS]: int(1, 72),
  [SettingKey.ATTENDANCE_AUTO_CLOSE_HOURS]: int(1, 168),
  [SettingKey.ATTENDANCE_CORRECTION_HOURS]: int(1, 720),
  [SettingKey.PAYMENTS_PENDING_CHECK_INTERVAL_MINUTES]: int(1, 60),
  [SettingKey.WEBHOOK_RATE_LIMIT_PER_MINUTE]: readOnly(PAYMENTS),
  [SettingKey.PAYMENTS_PROVIDER]: readOnly(PAYMENTS),
  // Fase 8B: comisión de Charles (ver bookings/commission-policy.ts).
  [SettingKey.FEES_PERCENT_BP]: int(0, 3000),
  [SettingKey.FEES_FIXED_AMOUNT]: int(0, 10_000),
  [SettingKey.FEES_PAYER]: {
    schema: { type: 'string', minLength: 6, maxLength: 10, pattern: /^(CLIENT|BARBERSHOP)$/ },
  },
  'payments.commission_policy': readOnly(
    'Reemplazado por fees.percent_bp, fees.fixed_amount y fees.payer.',
  ),
  'payments.payout_policy': readOnly(PENDING),
  'payments.methods': readOnly(PENDING),
  'payments.no_show_policy': readOnly(PENDING),
  [SettingKey.REVIEWS_WINDOW_DAYS]: int(1, 90),
  [SettingKey.REVIEWS_REPORT_THRESHOLD]: int(1, 50),
  [SettingKey.REVIEWS_RATE_LIMIT_PER_MINUTE]: int(1, 600),
  [SettingKey.SUPPORT_TICKET_REOPEN_DAYS]: int(1, 90),
  [SettingKey.SUPPORT_TICKET_AUTO_CLOSE_DAYS]: int(1, 90),
  [SettingKey.SUPPORT_MAX_OPEN_TICKETS_PER_USER]: int(1, 50),
  [SettingKey.SUPPORT_SUSPENSION_KEEP_HOURS]: int(1, 720),
  [SettingKey.NOTIFICATIONS_REMINDER_HOURS]: {
    schema: { type: 'integerList', min: 1, max: 168, minItems: 0, maxItems: 4 },
  },
  [SettingKey.NOTIFICATIONS_QUIET_START]: { schema: HH_MM },
  [SettingKey.NOTIFICATIONS_QUIET_END]: { schema: HH_MM },
  [SettingKey.NOTIFICATIONS_RETENTION_DAYS]: int(7, 365),
  [SettingKey.NOTIFICATIONS_MAX_DEVICES_PER_USER]: int(1, 50),
};

/** Ajustes que deben ser coherentes entre sí: se valida el conjunto con el valor nuevo. */
const CROSS_RULES: { keys: string[]; check: (v: Map<string, unknown>) => string | null }[] = [
  {
    keys: [SettingKey.REFUND_FULL_MIN_MINUTES, SettingKey.REFUND_PARTIAL_MIN_MINUTES],
    check: (v) => {
      const full = v.get(SettingKey.REFUND_FULL_MIN_MINUTES);
      const partial = v.get(SettingKey.REFUND_PARTIAL_MIN_MINUTES);
      return typeof full === 'number' && typeof partial === 'number' && partial > full
        ? 'refunds.partial_min_minutes no puede superar refunds.full_min_minutes.'
        : null;
    },
  },
  {
    keys: [SettingKey.SEARCH_DEFAULT_RADIUS_KM, SettingKey.SEARCH_MAX_RADIUS_KM],
    check: (v) => {
      const def = v.get(SettingKey.SEARCH_DEFAULT_RADIUS_KM);
      const max = v.get(SettingKey.SEARCH_MAX_RADIUS_KM);
      return typeof def === 'number' && typeof max === 'number' && def > max
        ? 'search.default_radius_km no puede superar search.max_radius_km.'
        : null;
    },
  },
  {
    keys: [SettingKey.SEARCH_DEFAULT_PAGE_SIZE, SettingKey.SEARCH_MAX_PAGE_SIZE],
    check: (v) => {
      const def = v.get(SettingKey.SEARCH_DEFAULT_PAGE_SIZE);
      const max = v.get(SettingKey.SEARCH_MAX_PAGE_SIZE);
      return typeof def === 'number' && typeof max === 'number' && def > max
        ? 'search.default_page_size no puede superar search.max_page_size.'
        : null;
    },
  },
];

/** Devuelve el motivo si el valor no cumple el esquema; null si es válido. Función pura. */
export function schemaViolation(schema: SettingSchema, value: unknown): string | null {
  switch (schema.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Debe ser verdadero o falso.';
    case 'integerList':
      if (
        !Array.isArray(value) ||
        value.some((v) => typeof v !== 'number' || !Number.isInteger(v))
      ) {
        return 'Debe ser una lista de números enteros.';
      }
      if (value.length < schema.minItems || value.length > schema.maxItems) {
        return `Debe tener entre ${schema.minItems} y ${schema.maxItems} valores.`;
      }
      if ((value as number[]).some((v) => v < schema.min || v > schema.max)) {
        return `Cada valor debe estar entre ${schema.min} y ${schema.max}.`;
      }
      if (new Set(value).size !== value.length) return 'No puede tener valores repetidos.';
      return null;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        return 'Debe ser un número entero.';
      if (value < schema.min || value > schema.max) {
        return `Debe estar entre ${schema.min} y ${schema.max}.`;
      }
      if (schema.multipleOf && value % schema.multipleOf !== 0) {
        return `Debe ser múltiplo de ${schema.multipleOf}.`;
      }
      return null;
    case 'string':
      if (typeof value !== 'string') return 'Debe ser texto.';
      if (value.length < schema.minLength || value.length > schema.maxLength) {
        return `Debe tener entre ${schema.minLength} y ${schema.maxLength} caracteres.`;
      }
      if (schema.pattern && !schema.pattern.test(value)) return 'El formato no es válido.';
      return null;
  }
}

export interface AdminSetting {
  key: string;
  value: unknown;
  description: string | null;
  editable: boolean;
  readOnlyReason: string | null;
  schema: Record<string, unknown> | null;
  updatedAt: string | null;
}

const describeSchema = (schema: SettingSchema | undefined): Record<string, unknown> | null => {
  if (!schema) return null;
  if (schema.type === 'string') {
    return {
      type: 'string',
      minLength: schema.minLength,
      maxLength: schema.maxLength,
      ...(schema.pattern ? { pattern: schema.pattern.source } : {}),
    };
  }
  return { ...schema };
};

const settingNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El ajuste no existe.', HttpStatus.NOT_FOUND);

/** `GET` y `PUT /admin/settings` (solo ADMIN). Cada cambio queda con el valor anterior y el nuevo. */
@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<AdminSetting[]> {
    const rows = await this.prisma.appSetting.findMany({ orderBy: { key: 'asc' } });
    return rows.map((row) => this.toDto(row));
  }

  async get(key: string): Promise<AdminSetting> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    if (!row) throw settingNotFound();
    return this.toDto(row);
  }

  async update(
    staff: StaffActor,
    key: string,
    value: unknown,
    reason: string,
  ): Promise<AdminSetting> {
    const rule = SETTING_RULES[key];
    const existing = await this.prisma.appSetting.findUnique({ where: { key } });
    if (!existing) throw settingNotFound();
    if (!rule?.schema || rule.readOnly) {
      throw new AppException(
        ErrorCode.SETTING_READ_ONLY,
        rule?.readOnly ?? 'Este ajuste no se puede editar desde el panel.',
        HttpStatus.FORBIDDEN,
      );
    }
    const violation = schemaViolation(rule.schema, value);
    if (violation) throw invalidValue(violation);

    return this.prisma.$transaction(async (tx) => {
      // Serializa los cambios de ajustes: las reglas cruzadas se validan sobre valores estables.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin:settings'))`;
      const cross = CROSS_RULES.filter((r) => r.keys.includes(key));
      if (cross.length > 0) {
        const keys = [...new Set(cross.flatMap((r) => r.keys))];
        const rows = await tx.appSetting.findMany({ where: { key: { in: keys } } });
        const values = new Map<string, unknown>(rows.map((r) => [r.key, r.value]));
        values.set(key, value);
        for (const rule of cross) {
          const problem = rule.check(values);
          if (problem) throw invalidValue(problem);
        }
      }
      const before = await tx.appSetting.findUniqueOrThrow({ where: { key } });
      const after = await tx.appSetting.update({
        where: { key },
        data: { value: value as Prisma.InputJsonValue },
      });
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'setting.updated',
          entityType: 'app_setting',
          entityId: null,
          changes: {
            key,
            from: before.value as Prisma.InputJsonValue,
            to: value as Prisma.InputJsonValue,
            reason,
            actorRole: staff.role,
          },
        },
        tx,
      );
      return this.toDto(after);
    });
  }

  private toDto(row: {
    key: string;
    value: unknown;
    description: string | null;
    updatedAt: Date;
  }): AdminSetting {
    const rule = SETTING_RULES[row.key];
    const editable = !!rule?.schema && !rule.readOnly;
    return {
      key: row.key,
      value: row.value,
      description: row.description,
      editable,
      readOnlyReason: editable
        ? null
        : (rule?.readOnly ?? 'Este ajuste no se puede editar desde el panel.'),
      schema: describeSchema(rule?.schema),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

const invalidValue = (message: string): AppException =>
  new AppException(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, [
    { field: 'value', constraints: ['settingSchema'] },
  ]);
