import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { AccountDeletionBookingDto } from '../../bookings/dto/booking.dto';

export class RequestAccountDeletionDto {
  @ApiProperty({ description: 'Contraseña actual (confirmación).' })
  @IsString()
  @MaxLength(256)
  password!: string;
}

export class DeletionBlockerDto {
  @ApiProperty({
    enum: ['SOLE_OWNER', 'STAFF_ROLE'],
    description:
      'SOLE_OWNER: único OWNER de una barbería (transfiere la propiedad o elimínala). ' +
      'STAFF_ROLE: cuenta de soporte o ADMIN (pide que te quiten el rol).',
  })
  reason!: 'SOLE_OWNER' | 'STAFF_ROLE';

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  barbershopId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  barbershopName!: string | null;
}

export class AccountDeletionStatusDto {
  @ApiProperty({ description: 'Hay una eliminación programada (se puede cancelar).' })
  pending!: boolean;

  @ApiProperty({ format: 'date-time', nullable: true, type: Date })
  requestedAt!: Date | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: Date,
    description: 'Cuándo se ejecuta (hasta entonces se puede cancelar).',
  })
  scheduledFor!: Date | null;
}

export class AccountDeletionPreviewDto {
  @ApiProperty({ description: 'Se puede solicitar ahora (sin bloqueos ni solicitud pendiente).' })
  canRequest!: boolean;

  @ApiProperty({ type: [DeletionBlockerDto] })
  blockers!: DeletionBlockerDto[];

  @ApiProperty({
    type: [AccountDeletionBookingDto],
    description:
      'Reservas que se cancelarán al confirmar (como cancelación del cliente) y cuánto se ' +
      'devuelve por cada una. No se restauran si luego se cancela la eliminación.',
  })
  bookings!: AccountDeletionBookingDto[];

  @ApiProperty({ example: 30 })
  graceDays!: number;

  @ApiProperty({ format: 'date-time' })
  scheduledForIfRequestedNow!: Date;

  @ApiProperty()
  pending!: boolean;
}
