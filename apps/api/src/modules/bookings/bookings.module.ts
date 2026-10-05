import { Module } from '@nestjs/common';
import { BookingsReadService } from './bookings-read.service';

/** Fase 4: solo lectura. Reservas, máquina de estados y outbox llegan en la Fase 7. */
@Module({
  providers: [BookingsReadService],
  exports: [BookingsReadService],
})
export class BookingsModule {}
