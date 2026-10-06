import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { PaymentStatus } from '../../../generated/prisma/enums';
import { MoneyDto } from '../../barbershops/dto/barbershop.dto';

export class ClientPaymentActionDto {
  @ApiProperty({ enum: ['FAKE', 'REDIRECT', 'SDK'] })
  type!: 'FAKE' | 'REDIRECT' | 'SDK';

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
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

/** Solo pruebas (NODE_ENV=test): simula el resultado que llegará por webhook en la Fase 8. */
export class FakePaymentResultDto {
  @ApiProperty({ enum: ['SUCCEEDED', 'REJECTED', 'CANCELLED'] })
  @IsIn(['SUCCEEDED', 'REJECTED', 'CANCELLED'])
  outcome!: 'SUCCEEDED' | 'REJECTED' | 'CANCELLED';
}
