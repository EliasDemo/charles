import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../common/config/app-config.token';
import { type AppConfig, PaymentsGateway } from '../../common/config/env.validation';
import { BILLING_GATEWAY } from './billing-gateway';
import { BillingController } from './billing.controller';
import { BillingWebhooksService } from './billing-webhooks.service';
import { FakeBillingGateway } from './fake-billing-gateway';
import { MercadoPagoBillingGateway } from './mercadopago-billing-gateway';

/**
 * Facturación de Charles (Fases 15 y 16): pasarela de cobros recurrentes y únicos, y recepción de
 * sus avisos. Mercado Pago si `PAYMENTS_GATEWAY=MERCADOPAGO`; si no, la simulada (Izipay no
 * ofrece suscripciones; en producción solo se admite Mercado Pago, ver payments-provider.check).
 */
@Global()
@Module({
  controllers: [BillingController],
  providers: [
    FakeBillingGateway,
    MercadoPagoBillingGateway,
    {
      provide: BILLING_GATEWAY,
      inject: [APP_CONFIG, FakeBillingGateway, MercadoPagoBillingGateway],
      useFactory: (config: AppConfig, fake: FakeBillingGateway, mp: MercadoPagoBillingGateway) =>
        config.payments.gateway === PaymentsGateway.MercadoPago ? mp : fake,
    },
    BillingWebhooksService,
  ],
  exports: [BILLING_GATEWAY, BillingWebhooksService, FakeBillingGateway],
})
export class BillingModule {}
