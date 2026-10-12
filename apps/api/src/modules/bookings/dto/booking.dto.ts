import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BookingStatus, PriceLineType } from '../../../generated/prisma/enums';
import { MoneyDto } from '../../barbershops/dto/barbershop.dto';
import { PaymentStartDto } from '../../payments/dto/payment.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** RF-RES-001/002. Cabecera obligatoria `Idempotency-Key` (UUID). */
export class CreateBookingDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  barbershopId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceId!: string;

  @ApiProperty({
    description: 'Inicio exacto de un turno ofrecido por la disponibilidad (ISO 8601).',
    example: '2030-01-07T14:00:00.000Z',
  })
  @Type(() => Date)
  @IsDate()
  startAt!: Date;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sin barbero: se asigna el libre con menos reservas activas ese día.',
  })
  @IsOptional()
  @IsUUID()
  barberId?: string;
}

/** RF-RES-005. El motivo es obligatorio cuando cancela la barbería. */
export class CancelBookingDto {
  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 300,
    description: 'Obligatorio si cancela la barbería (OWNER o MANAGER); el cliente puede omitirlo.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 300)
  reason?: string;
}

const CURSOR = /^[A-Za-z0-9_-]+$/;

/** RF-RES-004/008. */
export class BookingListQueryDto {
  @ApiPropertyOptional({
    enum: ['upcoming', 'history'],
    default: 'upcoming',
    description:
      'upcoming: activas que aún no empiezan. history: el resto (estado final o pasadas).',
  })
  @IsOptional()
  @IsIn(['upcoming', 'history'])
  scope?: 'upcoming' | 'history';

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(CURSOR)
  cursor?: string;
}

// ───────────── Respuestas ─────────────

export class NamedRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;
}

/** Cliente de una reserva, visto por la barbería: nombre y foto de perfil, nunca contacto. */
export class ClientRefDto extends NamedRefDto {
  @ApiProperty({ type: String, nullable: true, description: 'Foto de perfil; null si no tiene.' })
  photoUrl!: string | null;
}

/** Barbería de una reserva: las horas de la reserva se muestran en su zona. */
export class BookingBarbershopDto extends NamedRefDto {
  @ApiProperty({
    example: 'America/Lima',
    description: 'Zona IANA de la barbería: muestra las horas en esta zona.',
  })
  timezone!: string;
}

/** Servicio de una reserva: nombre tal como se reservó y su categoría (para íconos y filtros). */
export class BookingServiceDto extends NamedRefDto {
  @ApiProperty({ example: 'haircut', description: 'Clave de la categoría del servicio.' })
  categoryKey!: string;
}

export class PriceLineDto {
  @ApiProperty({ enum: PriceLineType, enumName: 'PriceLineType' })
  type!: PriceLineType;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: MoneyDto })
  amount!: MoneyDto;
}

export class BookingPriceDto {
  @ApiProperty({ type: MoneyDto })
  subtotal!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  discountTotal!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  feeTotal!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Incluye impuestos (ADR 0002).' })
  total!: MoneyDto;

  @ApiProperty({ type: [PriceLineDto] })
  lines!: PriceLineDto[];
}

export class CancellationDto {
  @ApiProperty({ enum: ['CLIENT', 'BARBERSHOP', 'SYSTEM', 'SUPPORT'] })
  byRole!: 'CLIENT' | 'BARBERSHOP' | 'SYSTEM' | 'SUPPORT';

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;
}

export class BookingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status!: BookingStatus;

  @ApiProperty({ type: BookingBarbershopDto })
  barbershop!: BookingBarbershopDto;

  @ApiProperty({
    type: BookingServiceDto,
    description: 'Nombre del servicio al reservar (copia) y su categoría.',
  })
  service!: BookingServiceDto;

  @ApiProperty({ type: NamedRefDto })
  barber!: NamedRefDto;

  @ApiProperty()
  barberChosenByClient!: boolean;

  @ApiProperty({
    type: ClientRefDto,
    nullable: true,
    description: 'Solo para la barbería y el barbero: nombre y foto del cliente (sin contacto).',
  })
  client!: ClientRefDto | null;

  @ApiProperty()
  startAt!: Date;

  @ApiProperty()
  endAt!: Date;

  @ApiProperty({ description: 'Duración copiada del servicio al reservar.' })
  durationMinutes!: number;

  @ApiProperty({ type: BookingPriceDto })
  price!: BookingPriceDto;

  @ApiProperty({ nullable: true, type: Date, description: 'Límite para pagar (PENDING_PAYMENT).' })
  expiresAt!: Date | null;

  @ApiProperty({ type: CancellationDto, nullable: true })
  cancellation!: CancellationDto | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({
    type: () => BookingCommissionDto,
    nullable: true,
    description:
      'Solo para la barbería: comisión de Charles de esta reserva y quién la paga. Para el cliente, null.',
  })
  commission!: BookingCommissionDto | null;

  @ApiProperty({
    description:
      'Solo para el cliente: puede valorar ahora (ATTENDED, sin valoración y dentro de ' +
      'reviews.window_days desde que quedó atendida). Para la barbería, siempre false.',
  })
  canReview!: boolean;

  @ApiProperty({
    type: () => BookingOwnReviewDto,
    nullable: true,
    description:
      'Solo para el cliente: su valoración de esta reserva, si existe. Para la barbería, null.',
  })
  review!: BookingOwnReviewDto | null;
}

/** Fase 8B: comisión de Charles congelada en la reserva. */
export class BookingCommissionDto {
  @ApiProperty({ type: MoneyDto })
  amount!: MoneyDto;

  @ApiProperty({
    enum: ['CLIENT', 'BARBERSHOP'],
    description:
      'BARBERSHOP: se descuenta de lo que recibe la barbería. CLIENT: la pagó el cliente.',
  })
  payer!: 'CLIENT' | 'BARBERSHOP';
}

/** Valoración propia del cliente, resumida (detalle en `GET /me/reviews`). */
export class BookingOwnReviewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  rating!: number;

  @ApiProperty({ description: 'Puede editarla (una sola vez, dentro del plazo).' })
  canEdit!: boolean;
}

export class RefundQuoteDto {
  @ApiProperty({ type: MoneyDto, description: 'Lo que se devolverá (redondeado hacia abajo).' })
  amount!: MoneyDto;

  @ApiProperty({ example: 50 })
  percent!: number;

  @ApiProperty({
    enum: [
      'NO_PAYMENT',
      'BARBERSHOP_CANCELLATION',
      'SUPPORT_CANCELLATION',
      'CLIENT_FULL',
      'CLIENT_PARTIAL',
      'CLIENT_NONE',
    ],
  })
  rule!: string;

  @ApiProperty({ type: MoneyDto, description: 'Cobrado y aún no devuelto (base del cálculo).' })
  paid!: MoneyDto;
}

/** Fase 8A: lo que la app muestra antes de confirmar la cancelación. */
export class CancellationPreviewDto {
  @ApiProperty()
  allowed!: boolean;

  @ApiProperty({
    nullable: true,
    enum: ['ALREADY_CANCELLED', 'NOT_CANCELLABLE', 'ALREADY_STARTED'],
    type: String,
  })
  reason!: string | null;

  @ApiProperty({ type: RefundQuoteDto })
  refund!: RefundQuoteDto;

  @ApiProperty({ description: 'true si cancela la barbería: el motivo es obligatorio.' })
  reasonRequired!: boolean;
}

export class CancelledBookingDto extends BookingDto {
  @ApiProperty({ type: RefundQuoteDto, description: 'Devolución aplicada.' })
  refund!: RefundQuoteDto;
}

export class CreatedBookingDto extends BookingDto {
  @ApiProperty({ type: PaymentStartDto })
  payment!: PaymentStartDto;
}

export class PendingReviewsDto {
  @ApiProperty({
    type: [BookingDto],
    description:
      'Reservas que el cliente puede valorar ahora (canReview), las más recientes primero.',
  })
  items!: BookingDto[];
}

export class BookingPageDto {
  @ApiProperty({ type: [BookingDto] })
  items!: BookingDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

/** Eliminación de cuenta: una reserva que se cancelará y cuánto se devuelve (misma política). */
export class AccountDeletionBookingDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ enum: [BookingStatus.PENDING_PAYMENT, BookingStatus.CONFIRMED] })
  status!: BookingStatus;

  @ApiProperty({ format: 'date-time' })
  startAt!: Date;

  @ApiProperty({ type: BookingBarbershopDto })
  barbershop!: BookingBarbershopDto;

  @ApiProperty({ type: RefundQuoteDto })
  refund!: RefundQuoteDto;
}
