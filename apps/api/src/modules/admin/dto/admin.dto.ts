import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination';
import {
  BarbershopReportReason,
  BarbershopStatus,
  BarbershopType,
  BookingStatus,
  ReviewReportTarget,
  ReviewStatus,
  Role,
  UserStatus,
} from '../../../generated/prisma/enums';
import { normalizeText } from '../../reviews/review-policy';

const toPlainText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizeText(value) : value;

// ───────────── Peticiones ─────────────

/** Toda acción sensible lleva motivo (queda en `audit_log`). */
export class ReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(toPlainText)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class FindUserQueryDto {
  @ApiPropertyOptional({ description: 'Correo exacto.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ description: 'Nombre de usuario exacto.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MaxLength(20)
  username?: string;
}

export class ContactAccessDto extends ReasonDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Ticket de esa cuenta que lo justifica.' })
  @IsOptional()
  @IsUUID()
  ticketId?: string;
}

export class AdminBarbershopQueryDto extends OmitType(PaginationQueryDto, ['cursor'] as const) {
  @ApiPropertyOptional({ description: 'Valor de nextCursor de la página anterior.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;

  @ApiPropertyOptional({
    enum: BarbershopStatus,
    description: 'Sin estado: las que necesitan atención (reportes, marcas, pendientes).',
  })
  @IsOptional()
  @IsEnum(BarbershopStatus)
  status?: BarbershopStatus;
}

export class SuspendBarbershopDto extends ReasonDto {
  @ApiPropertyOptional({
    enum: ['KEEP_UPCOMING', 'CANCEL_ALL', 'KEEP_ALL'],
    default: 'KEEP_UPCOMING',
    description:
      'Reservas futuras: KEEP_UPCOMING mantiene las de las próximas support.suspension_keep_hours ' +
      '(48) y cancela el resto con devolución total. Las pendientes de pago se cancelan siempre.',
  })
  @IsOptional()
  @IsIn(['KEEP_UPCOMING', 'CANCEL_ALL', 'KEEP_ALL'])
  bookings?: 'KEEP_UPCOMING' | 'CANCEL_ALL' | 'KEEP_ALL';
}

export class ResolveReportsDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Resolución (queda en los reportes).' })
  @Transform(toPlainText)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  resolution!: string;
}

export class SupportAttendanceCorrectionDto extends ReasonDto {
  @ApiProperty({ enum: [BookingStatus.ATTENDED, BookingStatus.NO_SHOW] })
  @IsIn([BookingStatus.ATTENDED, BookingStatus.NO_SHOW])
  status!: 'ATTENDED' | 'NO_SHOW';
}

export class ManualRefundDto extends ReasonDto {
  @ApiProperty({ minimum: 1, description: 'Céntimos; hasta lo cobrado y aún no devuelto.' })
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amount!: number;
}

export class CancellationVerdictDto extends ReasonDto {
  @ApiProperty({ enum: ['JUSTIFIED', 'UNJUSTIFIED'] })
  @IsIn(['JUSTIFIED', 'UNJUSTIFIED'])
  verdict!: 'JUSTIFIED' | 'UNJUSTIFIED';
}

export class CancellationReviewQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['PENDING_REVIEW', 'JUSTIFIED', 'UNJUSTIFIED'] })
  @IsOptional()
  @IsIn(['PENDING_REVIEW', 'JUSTIFIED', 'UNJUSTIFIED'])
  status?: 'PENDING_REVIEW' | 'JUSTIFIED' | 'UNJUSTIFIED';
}

export class ReviewModerationDto extends ReasonDto {
  @ApiPropertyOptional({ enum: ReviewReportTarget, default: ReviewReportTarget.REVIEW })
  @IsOptional()
  @IsEnum(ReviewReportTarget)
  target?: ReviewReportTarget;

  @ApiProperty({
    enum: ['KEEP', 'HIDE', 'RESTORE'],
    description: 'KEEP: vuelve a visible. HIDE: oculta. RESTORE: muestra lo que ocultó soporte.',
  })
  @IsIn(['KEEP', 'HIDE', 'RESTORE'])
  decision!: 'KEEP' | 'HIDE' | 'RESTORE';
}

export class UpdateSettingDto extends ReasonDto {
  @ApiProperty({
    description: 'Nuevo valor, según el esquema del ajuste (cualquier JSON).',
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', items: {} },
      { type: 'object', additionalProperties: true },
    ],
  })
  @IsDefined()
  value!: unknown;
}

export class CreateCategoryDto {
  @ApiProperty({ example: 'beard', description: 'Clave estable en minúsculas.' })
  @Matches(/^[a-z][a-z0-9_]{1,39}$/)
  key!: string;

  @ApiProperty({ minLength: 2, maxLength: 60 })
  @Transform(toPlainText)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 60 })
  @IsOptional()
  @Transform(toPlainText)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'false la desactiva (nunca se borra).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ───────────── Respuestas ─────────────

export class RefNameDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class RefShopWithZoneDto extends RefNameDto {
  @ApiProperty({
    example: 'America/Lima',
    description: 'Zona IANA de la barbería: muestra las horas en esta zona.',
  })
  timezone!: string;
}

export class RefBarberDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  displayName!: string;
}

export class RefPersonDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

/** Datos mínimos de una cuenta para soporte: nunca correo, teléfono ni documento. */
export class StaffUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'ana.perez' })
  username!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ enum: UserStatus })
  status!: UserStatus;

  @ApiProperty({ enum: Role, isArray: true })
  roles!: Role[];

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty()
  deleted!: boolean;
}

export class ContactDto {
  @ApiProperty()
  email!: string;

  @ApiProperty({ nullable: true, type: String })
  phone!: string | null;
}

export class AdminBarbershopDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: BarbershopStatus })
  status!: BarbershopStatus;

  @ApiProperty({ enum: BarbershopType })
  type!: BarbershopType;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Marca del sistema, p. ej. owner_disabled.',
  })
  flaggedReason!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  flaggedAt!: string | null;

  @ApiProperty()
  openReports!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Envío a revisión en espera.',
  })
  submittedForReviewAt!: string | null;

  @ApiProperty({
    enum: ['RUC', 'DNI'],
    nullable: true,
    type: String,
    description: 'Solo el tipo; el número se pide aparte con motivo.',
  })
  ownerDocumentType!: 'RUC' | 'DNI' | null;

  @ApiProperty({
    format: 'date-time',
    description:
      'Desde cuándo espera atención (envío, marca o reporte más antiguo). La cola se ordena por esto.',
  })
  waitingSince!: string;
}

export class AdminBarbershopPageDto {
  @ApiProperty({ type: [AdminBarbershopDto] })
  items!: AdminBarbershopDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class BarbershopReportDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: BarbershopReportReason })
  reason!: BarbershopReportReason;

  @ApiProperty({ nullable: true, type: String })
  details!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminReviewSubmissionDto {
  @ApiProperty({ format: 'date-time' })
  submittedAt!: string;

  @ApiProperty({ enum: ['APPROVED', 'CHANGES_REQUESTED'], nullable: true, type: String })
  decision!: 'APPROVED' | 'CHANGES_REQUESTED' | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  decidedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;
}

export class OwnerDocumentDto {
  @ApiProperty({ enum: ['RUC', 'DNI'] })
  type!: string;

  @ApiProperty()
  number!: string;
}

export class AdminBarbershopDetailDto extends AdminBarbershopDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Motivo de la última solicitud de cambios.',
  })
  reviewNotes!: string | null;

  @ApiProperty({
    type: [AdminReviewSubmissionDto],
    description: 'Envíos a revisión, el más reciente primero.',
  })
  submissions!: AdminReviewSubmissionDto[];

  @ApiProperty({ type: [BarbershopReportDto], description: 'Reportes abiertos.' })
  reports!: BarbershopReportDto[];
}

export class SuspensionResultDto {
  @ApiProperty({ enum: [BarbershopStatus.SUSPENDED] })
  status!: 'SUSPENDED';

  @ApiProperty({ enum: ['KEEP_UPCOMING', 'CANCEL_ALL', 'KEEP_ALL'] })
  mode!: 'KEEP_UPCOMING' | 'CANCEL_ALL' | 'KEEP_ALL';

  @ApiProperty()
  cancelledBookings!: number;

  @ApiProperty({ description: 'Reservas confirmadas futuras que se mantienen.' })
  keptBookings!: number;
}

export class AdminRefundDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  reasonType!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminPaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  provider!: string;

  @ApiProperty({ description: 'Cobrado y aún no devuelto.' })
  refundable!: number;

  @ApiProperty({ type: [AdminRefundDto] })
  refunds!: AdminRefundDto[];
}

export class AdminHistoryDto {
  @ApiProperty({ nullable: true, type: String })
  from!: string | null;

  @ApiProperty()
  to!: string;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ format: 'date-time' })
  at!: string;
}

/** Reserva para soporte: datos mínimos (del cliente, solo el nombre). */
export class AdminBookingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: BookingStatus })
  status!: BookingStatus;

  @ApiProperty({ format: 'date-time' })
  startAt!: string;

  @ApiProperty({ format: 'date-time' })
  endAt!: string;

  @ApiProperty()
  serviceName!: string;

  @ApiProperty()
  totalAmount!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ type: RefShopWithZoneDto })
  barbershop!: RefShopWithZoneDto;

  @ApiProperty({ type: RefBarberDto })
  barber!: RefBarberDto;

  @ApiProperty({ type: RefPersonDto })
  client!: RefPersonDto;

  @ApiProperty({ type: [AdminHistoryDto] })
  history!: AdminHistoryDto[];

  @ApiProperty({ type: [AdminPaymentDto] })
  payments!: AdminPaymentDto[];
}

export class AdminCancellationReviewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ type: RefNameDto })
  barbershop!: RefNameDto;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ format: 'date-time' })
  cancelledAt!: string;

  @ApiProperty({ enum: ['PENDING_REVIEW', 'JUSTIFIED', 'UNJUSTIFIED'] })
  status!: string;
}

export class AdminCancellationReviewPageDto {
  @ApiProperty({ type: [AdminCancellationReviewDto] })
  items!: AdminCancellationReviewDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class VerdictResultDto {
  @ApiProperty({ enum: ['JUSTIFIED', 'UNJUSTIFIED'] })
  verdict!: string;

  @ApiProperty({ description: 'Si este veredicto suspendió la barbería.' })
  barbershopSuspended!: boolean;
}

export class ReportCountDto {
  @ApiProperty()
  reason!: string;

  @ApiProperty()
  count!: number;
}

export class AdminReviewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  rating!: number;

  @ApiProperty({ nullable: true, type: String })
  comment!: string | null;

  @ApiProperty({ enum: ReviewStatus })
  status!: ReviewStatus;

  @ApiProperty({ nullable: true, type: String })
  responseText!: string | null;

  @ApiProperty({ enum: ReviewStatus, nullable: true })
  responseStatus!: ReviewStatus | null;

  @ApiProperty({ type: RefNameDto })
  barbershop!: RefNameDto;

  @ApiProperty({ type: [ReportCountDto], description: 'Reportes abiertos de la valoración.' })
  reviewReports!: ReportCountDto[];

  @ApiProperty({ type: [ReportCountDto], description: 'Reportes abiertos de la respuesta.' })
  responseReports!: ReportCountDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminReviewPageDto {
  @ApiProperty({ type: [AdminReviewDto] })
  items!: AdminReviewDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class ModerationResultDto {
  @ApiProperty({ enum: ReviewStatus })
  status!: ReviewStatus;

  @ApiProperty()
  resolvedReports!: number;
}

export class AdminSettingDto {
  @ApiProperty()
  key!: string;

  @ApiProperty({
    nullable: true,
    description: 'Valor actual (cualquier JSON).',
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', items: {} },
      { type: 'object', additionalProperties: true },
    ],
  })
  value!: unknown;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty()
  editable!: boolean;

  @ApiProperty({ nullable: true, type: String })
  readOnlyReason!: string | null;

  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'type y rango (min, max, multipleOf) o longitud.',
  })
  schema!: Record<string, unknown> | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  updatedAt!: string | null;
}

export class AdminCategoryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  key!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ description: 'Servicios que la usan.' })
  servicesCount!: number;
}

export class RefundRequestedDto {
  @ApiProperty({ format: 'uuid' })
  refundId!: string;
}

export class AdminFailedRefundDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  reasonType!: string;

  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminFailedRefundPageDto {
  @ApiProperty({ type: [AdminFailedRefundDto] })
  items!: AdminFailedRefundDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
