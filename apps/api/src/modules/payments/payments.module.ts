import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { SettingsModule } from '../settings/settings.module';
import { APP_CONFIG } from '../../common/config/app-config.token';
import { type AppConfig, PaymentsGateway } from '../../common/config/env.validation';
import { UsersModule } from '../users/users.module';
import { PaymentPagesController } from './checkout-pages';
import { FakeGateway } from './fake-gateway';
import { IzipayCheckoutController } from './izipay/izipay-checkout.controller';
import { IzipayCheckoutService } from './izipay/izipay-checkout.service';
import { IzipayGateway } from './izipay/izipay-gateway';
import { MercadoPagoGateway } from './mercadopago/mercadopago-gateway';
import { MercadoPagoReturnController } from './mercadopago/mercadopago-return.controller';
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
 * Pagos (Fases 8A y 8B): cobro, webhooks firmados, reembolsos, conciliación. Independiente del
 * proveedor: `PAYMENTS_GATEWAY` elige `FakeGateway` (desarrollo y pruebas) o `IzipayGateway`.
 */
@Module({
  imports: [
    BookingsModule,
    SettingsModule,
    UsersModule,
    BullModule.registerQueue({ name: PAYMENTS_QUEUE }),
  ],
  controllers: [
    PaymentsController,
    PaymentPagesController,
    IzipayCheckoutController,
    MercadoPagoReturnController,
  ],
  providers: [
    FakeGateway,
    IzipayGateway,
    MercadoPagoGateway,
    {
      provide: PAYMENT_GATEWAY,
      inject: [APP_CONFIG, FakeGateway, IzipayGateway, MercadoPagoGateway],
      useFactory: (
        config: AppConfig,
        fake: FakeGateway,
        izipay: IzipayGateway,
        mercadoPago: MercadoPagoGateway,
      ) =>
        config.payments.gateway === PaymentsGateway.Izipay
          ? izipay
          : config.payments.gateway === PaymentsGateway.MercadoPago
            ? mercadoPago
            : fake,
    },
    IzipayCheckoutService,
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
