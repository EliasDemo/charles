import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus, RefundReason, RefundStatus } from '../../../generated/prisma/enums';
import { MoneyDto } from '../../barbershops/dto/barbershop.dto';

export class ClientPaymentActionDto {
  @ApiProperty({
    enum: ['FAKE', 'IZIPAY_WEB'],
    description:
      'FAKE: pasarela simulada (desarrollo; pagar con dev:pay). IZIPAY_WEB: abrir data.paymentUrl ' +
      '(formulario de Izipay con tarjeta y Yape) en un WebView; el pago termina cuando la página ' +
      'navega a una URL que contiene /payments/izipay/done.',
  })
  type!: 'FAKE' | 'IZIPAY_WEB';

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'FAKE: { paymentId }. IZIPAY_WEB: { paymentUrl, doneUrlPrefix }.',
  })
  data!: Record<string, string>;
}

export class PaymentStartDto {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ example: 'FAKE' })
  provider!: string;

  @ApiProperty({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  status!: PaymentStatus;

  @ApiProperty({ type: MoneyDto })
  amount!: MoneyDto;

  @ApiProperty({
    type: ClientPaymentActionDto,
    nullable: true,
    description: 'null si la pasarela no respondió: reintentar con POST /bookings/{id}/payment.',
  })
  clientAction!: ClientPaymentActionDto | null;
}

export class RefundViewDto {
  @ApiProperty({ format: 'uuid' })
  refundId!: string;

  @ApiProperty({ enum: RefundStatus, enumName: 'RefundStatus' })
  status!: RefundStatus;

  @ApiProperty({ enum: RefundReason, enumName: 'RefundReason' })
  reasonType!: RefundReason;

  @ApiProperty({ type: MoneyDto })
  amount!: MoneyDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ nullable: true, type: Date })
  processedAt!: Date | null;
}

export class PaymentViewDto {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty()
  provider!: string;

  @ApiProperty({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  status!: PaymentStatus;

  @ApiProperty({ type: MoneyDto })
  amount!: MoneyDto;

  @ApiProperty({ nullable: true, type: Date, description: 'Cuándo la pasarela aceptó el pago.' })
  startedAt!: Date | null;

  @ApiProperty({ nullable: true, type: Date })
  confirmedAt!: Date | null;

  @ApiProperty({ type: [RefundViewDto] })
  refunds!: RefundViewDto[];
}

export class PaymentStatusDto {
  @ApiProperty({ type: [PaymentViewDto] })
  items!: PaymentViewDto[];
}

export class PaymentVerificationDto {
  @ApiProperty({
    enum: ['CONFIRMED', 'REVIEW', 'UNCHANGED', 'UNAVAILABLE'],
    description:
      'Resultado de consultar a la pasarela. La respuesta de la app nunca confirma por sí sola.',
  })
  outcome!: 'CONFIRMED' | 'REVIEW' | 'UNCHANGED' | 'UNAVAILABLE';

  @ApiProperty({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  paymentStatus!: PaymentStatus;
}

export class WebhookReceiptDto {
  @ApiProperty()
  received!: true;

  @ApiProperty({ description: 'true si el evento ya se había recibido (no se aplica de nuevo).' })
  duplicate!: boolean;
}
