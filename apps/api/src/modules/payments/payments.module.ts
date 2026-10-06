import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { SettingsModule } from '../settings/settings.module';
import { FakeGateway } from './fake-gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';
import { PaymentsProviderCheck } from './payments-provider.check';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Pagos (Fase 7: punto de unión con FakeGateway; webhooks, reembolsos e Izipay en la Fase 8).
 */
@Module({
  imports: [BookingsModule, SettingsModule],
  controllers: [PaymentsController],
  providers: [
    FakeGateway,
    { provide: PAYMENT_GATEWAY, useExisting: FakeGateway },
    PaymentsService,
    PaymentsProviderCheck,
  ],
  exports: [PaymentsService, FakeGateway],
})
export class PaymentsModule {}
