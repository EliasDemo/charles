import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';

export const SettingKey = {
  TERMS_VERSION: 'legal.terms_version',
  TERMS_URL: 'legal.terms_url',
  ACCOUNT_DELETION_GRACE_DAYS: 'account_deletion.grace_days',
  ACCOUNT_DELETION_EMAIL_BLOCK_DAYS: 'account_deletion.email_block_days',
  ACCOUNT_DELETION_LEGAL_RETENTION_DAYS: 'account_deletion.legal_retention_days',
  PRIVACY_URL: 'legal.privacy_url',
  LOCKOUT_ACCOUNT_MAX_FAILURES: 'auth.lockout.account_max_failures',
  LOCKOUT_IP_MAX_FAILURES: 'auth.lockout.ip_max_failures',
  BARBERSHOPS_REQUIRE_REVIEW: 'barbershops.require_review',
  BARBERSHOPS_REQUIRE_PHOTO: 'barbershops.require_photo',
  IMAGES_GALLERY_MAX: 'images.gallery_max_per_barber',
  IMAGES_PINNED_MAX: 'images.pinned_max_per_barber',
  IMAGES_REPORT_HIDE_THRESHOLD: 'images.report_hide_threshold',
  IMAGES_UPLOAD_RATE_LIMIT_PER_MINUTE: 'images.upload_rate_limit_per_minute',
  INVITATION_TTL_MINUTES: 'barbershops.invitation_ttl_minutes',
  SLOT_INTERVAL_MINUTES: 'availability.slot_interval_minutes',
  MIN_LEAD_TIME_MINUTES: 'availability.min_lead_time_minutes',
  BOOKING_HORIZON_DAYS: 'availability.booking_horizon_days',
  NOW_WINDOW_MINUTES: 'availability.now_window_minutes',
  PENDING_PAYMENT_TTL_MINUTES: 'booking.pending_payment_ttl_minutes',
  SEARCH_DEFAULT_RADIUS_KM: 'search.default_radius_km',
  SEARCH_MAX_RADIUS_KM: 'search.max_radius_km',
  SEARCH_DEFAULT_PAGE_SIZE: 'search.default_page_size',
  SEARCH_MAX_PAGE_SIZE: 'search.max_page_size',
  SEARCH_MAX_CANDIDATES: 'search.max_candidates',
  SEARCH_RATE_LIMIT_PER_MINUTE: 'search.rate_limit_per_minute',
  BOOKING_MAX_PENDING_PER_CLIENT: 'booking.max_pending_per_client',
  BOOKING_RATE_LIMIT_PER_MINUTE: 'booking.rate_limit_per_minute',
  REFUND_FULL_MIN_MINUTES: 'refunds.full_min_minutes',
  REFUND_PARTIAL_MIN_MINUTES: 'refunds.partial_min_minutes',
  REFUND_PARTIAL_PERCENT: 'refunds.partial_percent',
  UNJUSTIFIED_CANCELLATIONS_LIMIT: 'barbershops.unjustified_cancellations_limit',
  UNJUSTIFIED_CANCELLATIONS_WINDOW_DAYS: 'barbershops.unjustified_cancellations_window_days',
  NO_SHOW_AFTER_MINUTES: 'booking.no_show_after_minutes',
  NO_SHOW_WINDOW_HOURS: 'booking.no_show_window_hours',
  ATTENDANCE_AUTO_CLOSE_HOURS: 'booking.attendance_auto_close_hours',
  ATTENDANCE_CORRECTION_HOURS: 'booking.attendance_correction_hours',
  PAYMENTS_PENDING_CHECK_INTERVAL_MINUTES: 'payments.pending_check_interval_minutes',
  WEBHOOK_RATE_LIMIT_PER_MINUTE: 'payments.webhook_rate_limit_per_minute',
  PAYMENTS_PROVIDER: 'payments.provider',
  REVIEWS_WINDOW_DAYS: 'reviews.window_days',
  REVIEWS_REPORT_THRESHOLD: 'reviews.report_threshold',
  REVIEWS_RATE_LIMIT_PER_MINUTE: 'reviews.rate_limit_per_minute',
  SUPPORT_TICKET_REOPEN_DAYS: 'support.ticket_reopen_days',
  SUPPORT_TICKET_AUTO_CLOSE_DAYS: 'support.ticket_auto_close_days',
  SUPPORT_MAX_OPEN_TICKETS_PER_USER: 'support.max_open_tickets_per_user',
  SUPPORT_SUSPENSION_KEEP_HOURS: 'support.suspension_keep_hours',
  NOTIFICATIONS_REMINDER_HOURS: 'notifications.reminder_hours',
  NOTIFICATIONS_QUIET_START: 'notifications.quiet_start',
  NOTIFICATIONS_QUIET_END: 'notifications.quiet_end',
  NOTIFICATIONS_RETENTION_DAYS: 'notifications.retention_days',
  NOTIFICATIONS_MAX_DEVICES_PER_USER: 'notifications.max_devices_per_user',
} as const;

/** Lectura de `app_settings` (clave/valor). Las políticas pendientes valen JSON `null`. */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(key: string): Promise<unknown> {
    const setting = await this.prisma.appSetting.findUnique({ where: { key } });
    return setting?.value ?? null;
  }

  /**
   * Entero positivo configurable. Si la clave no existe o su valor no es válido, se usa
   * `fallback` (el valor decidido en CLAUDE.md), y un valor inválido queda registrado en el log.
   */
  async positiveInt(key: string, fallback: number): Promise<number> {
    const value = await this.get(key);
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (value !== null) this.logger.warn(`Valor inválido en ${key}; se usa ${fallback}`);
    return fallback;
  }

  /** Booleano configurable; `fallback` si la clave no existe o no es booleana. */
  async boolean(key: string, fallback: boolean): Promise<boolean> {
    const value = await this.get(key);
    if (typeof value === 'boolean') return value;
    if (value !== null) this.logger.warn(`Valor inválido en ${key}; se usa ${fallback}`);
    return fallback;
  }

  /** Versión vigente de los términos y condiciones (CLAUDE.md §4.1). */
  async termsVersion(): Promise<string> {
    const value = await this.get(SettingKey.TERMS_VERSION);
    if (typeof value !== 'string' || value.length === 0) {
      this.logger.error(`Falta configurar ${SettingKey.TERMS_VERSION} en app_settings`);
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'El servicio no está disponible temporalmente.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return value;
  }
}
