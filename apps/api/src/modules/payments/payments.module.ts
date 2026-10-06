import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { SettingsModule } from '../settings/settings.module';
import { FakeGateway } from './fake-gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';
import { PaymentVerificationService } from './payment-verification.service';
import { PaymentsProviderCheck } from './payments-provider.check';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import {
  PAYMENTS_QUEUE,
  PaymentsProcessor,
  PaymentsScheduler,
  ReconciliationService,
} from './reconciliation';
import { RefundExecutor } from './refund-executor';
import { WebhookRateLimiter, WebhookRateLimitRefresher } from './webhook-rate-limit';
import { WebhooksService } from './webhooks.service';

/**
 * Pagos (Fase 8A): cobro, webhooks firmados, reembolsos, conciliación. Independiente del
 * proveedor: hoy `FakeGateway`; el adaptador de Izipay llega en la Fase 8B.
 */
@Module({
  imports: [BookingsModule, SettingsModule, BullModule.registerQueue({ name: PAYMENTS_QUEUE })],
  controllers: [PaymentsController],
  providers: [
    FakeGateway,
    { provide: PAYMENT_GATEWAY, useExisting: FakeGateway },
    PaymentsService,
    PaymentsProviderCheck,
    WebhooksService,
    WebhookRateLimiter,
    WebhookRateLimitRefresher,
    PaymentVerificationService,
    ReconciliationService,
    RefundExecutor,
    PaymentsProcessor,
    PaymentsScheduler,
  ],
  exports: [PaymentsService, ReconciliationService, FakeGateway],
})
export class PaymentsModule {}
