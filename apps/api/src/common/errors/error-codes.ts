import { HttpStatus } from '@nestjs/common';

/** Códigos de error estables expuestos por la API. Agregar valores nunca rompe clientes. */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MALFORMED_JSON: 'MALFORMED_JSON',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  HTTPS_REQUIRED: 'HTTPS_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // Autenticación (Fase 3)
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  INVALID_CODE: 'INVALID_CODE',
  TERMS_VERSION_OUTDATED: 'TERMS_VERSION_OUTDATED',
  // Barberías, barberos y servicios (Fase 4)
  LAST_OWNER: 'LAST_OWNER',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  STATUS_CHANGE_NOT_ALLOWED: 'STATUS_CHANGE_NOT_ALLOWED',
  HAS_FUTURE_BOOKINGS: 'HAS_FUTURE_BOOKINGS',
  BARBER_ALREADY_ACTIVE_ELSEWHERE: 'BARBER_ALREADY_ACTIVE_ELSEWHERE',
  BARBER_ALREADY_LINKED: 'BARBER_ALREADY_LINKED',
  INVITATION_NO_LONGER_VALID: 'INVITATION_NO_LONGER_VALID',
  INDEPENDENT_SINGLE_BARBER: 'INDEPENDENT_SINGLE_BARBER',
  // Horarios y disponibilidad (Fase 5)
  DATE_OUT_OF_RANGE: 'DATE_OUT_OF_RANGE',
  BLOCK_OVERLAPS_BOOKINGS: 'BLOCK_OVERLAPS_BOOKINGS',
  // Búsqueda (Fase 6)
  INVALID_CURSOR: 'INVALID_CURSOR',
  // Reservas (Fase 7)
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  SLOT_NOT_AVAILABLE: 'SLOT_NOT_AVAILABLE',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  TOO_MANY_PENDING_BOOKINGS: 'TOO_MANY_PENDING_BOOKINGS',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  CANCELLATION_NOT_ALLOWED: 'CANCELLATION_NOT_ALLOWED',
  ALREADY_CANCELLED: 'ALREADY_CANCELLED',
  PAYMENT_NOT_AVAILABLE: 'PAYMENT_NOT_AVAILABLE',
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  // Pagos (Fase 8A)
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  WEBHOOK_TOO_OLD: 'WEBHOOK_TOO_OLD',
  WEBHOOK_MISMATCH: 'WEBHOOK_MISMATCH',
  ALREADY_REVIEWED: 'ALREADY_REVIEWED',
  NO_SHOW_NOT_ALLOWED: 'NO_SHOW_NOT_ALLOWED',
  // Atención (Fase 9)
  ATTENDANCE_NOT_ALLOWED: 'ATTENDANCE_NOT_ALLOWED',
  ATTENDANCE_CORRECTION_NOT_ALLOWED: 'ATTENDANCE_CORRECTION_NOT_ALLOWED',
  // Valoraciones (Fase 11)
  REVIEW_NOT_ALLOWED: 'REVIEW_NOT_ALLOWED',
  REVIEW_ALREADY_EXISTS: 'REVIEW_ALREADY_EXISTS',
  REVIEW_EDIT_NOT_ALLOWED: 'REVIEW_EDIT_NOT_ALLOWED',
  ALREADY_REPORTED: 'ALREADY_REPORTED',
  // Soporte y operación (Fase 12)
  CONFLICT_OF_INTEREST: 'CONFLICT_OF_INTEREST',
  LAST_ADMIN: 'LAST_ADMIN',
  SETTING_READ_ONLY: 'SETTING_READ_ONLY',
  REFUND_EXCEEDS_PAID: 'REFUND_EXCEEDS_PAID',
  TICKET_CLOSED: 'TICKET_CLOSED',
  // Eliminación de cuenta
  ACCOUNT_PENDING_DELETION: 'ACCOUNT_PENDING_DELETION',
  DELETION_BLOCKED: 'DELETION_BLOCKED',
  // Alta con revisión previa
  REVIEW_REQUIREMENTS_MISSING: 'REVIEW_REQUIREMENTS_MISSING',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode] | (string & {});

interface DefaultError {
  code: ErrorCode;
  message: string;
}

/** Código y mensaje genéricos por estado HTTP, para errores que no son `AppException`. */
const DEFAULTS_BY_STATUS: Partial<Record<number, DefaultError>> = {
  [HttpStatus.BAD_REQUEST]: {
    code: ErrorCode.BAD_REQUEST,
    message: 'La solicitud no es válida.',
  },
  [HttpStatus.UNAUTHORIZED]: {
    code: ErrorCode.UNAUTHORIZED,
    message: 'Debes iniciar sesión para continuar.',
  },
  [HttpStatus.FORBIDDEN]: {
    code: ErrorCode.FORBIDDEN,
    message: 'No tienes permiso para realizar esta acción.',
  },
  [HttpStatus.NOT_FOUND]: {
    code: ErrorCode.NOT_FOUND,
    message: 'El recurso solicitado no existe.',
  },
  [HttpStatus.METHOD_NOT_ALLOWED]: {
    code: ErrorCode.METHOD_NOT_ALLOWED,
    message: 'Método no permitido para este recurso.',
  },
  [HttpStatus.CONFLICT]: {
    code: ErrorCode.CONFLICT,
    message: 'La solicitud entra en conflicto con el estado actual del recurso.',
  },
  [HttpStatus.PAYLOAD_TOO_LARGE]: {
    code: ErrorCode.PAYLOAD_TOO_LARGE,
    message: 'El contenido enviado supera el tamaño permitido.',
  },
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: {
    code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    message: 'El tipo de contenido no está soportado.',
  },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    code: ErrorCode.TOO_MANY_REQUESTS,
    message: 'Demasiadas solicitudes. Intenta nuevamente en unos momentos.',
  },
  [HttpStatus.SERVICE_UNAVAILABLE]: {
    code: ErrorCode.SERVICE_UNAVAILABLE,
    message: 'El servicio no está disponible temporalmente.',
  },
};

const INTERNAL: DefaultError = {
  code: ErrorCode.INTERNAL_ERROR,
  message: 'Ocurrió un error inesperado. Intenta nuevamente más tarde.',
};

export function defaultErrorFor(status: number): DefaultError {
  return DEFAULTS_BY_STATUS[status] ?? (status >= 500 ? INTERNAL : DEFAULTS_BY_STATUS[400]!);
}
