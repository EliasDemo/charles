import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';

export const FAKE_PROVIDER = 'FAKE';

/** Errores de configuración de pagos para el arranque (vacío = correcto). */
export function paymentProviderErrors(
  isProduction: boolean,
  configuredProvider: unknown,
  gatewayProvider: string,
): string[] {
  const configured = typeof configuredProvider === 'string' ? configuredProvider : FAKE_PROVIDER;
  if (isProduction && (configured === FAKE_PROVIDER || gatewayProvider === FAKE_PROVIDER)) {
    return ['payments.provider: la pasarela simulada (FAKE) no se permite en producción'];
  }
  return [];
}

/**
 * Igual que con el correo simulado (MAILER_DRIVER), la app no arranca en producción con la
 * pasarela simulada. `payments.provider` vive en app_settings, por eso se valida al iniciar.
 */
@Injectable()
export class PaymentsProviderCheck implements OnApplicationBootstrap {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly settings: SettingsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.isProduction) return;
    const errors = paymentProviderErrors(
      true,
      await this.settings.get(SettingKey.PAYMENTS_PROVIDER),
      this.gateway.provider,
    );
    if (errors.length > 0) {
      throw new Error(`Configuración de pagos inválida:\n - ${errors.join('\n - ')}`);
    }
  }
}
