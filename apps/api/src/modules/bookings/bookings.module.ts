import { Module } from '@nestjs/common';
import { BookingStateMachine } from './booking-state-machine';
import { BookingsReadService } from './bookings-read.service';

/**
 * Núcleo de reservas que otros módulos pueden importar sin ciclos: lecturas para la
 * disponibilidad y la máquina de estados (pagos la usa para confirmar). La gestión de reservas
 * (crear, cancelar, consultar) vive en `BookingsManagementModule`.
 */
@Module({
  providers: [BookingsReadService, BookingStateMachine],
  exports: [BookingsReadService, BookingStateMachine],
})
export class BookingsModule {}
