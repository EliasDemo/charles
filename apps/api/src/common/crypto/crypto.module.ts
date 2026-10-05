import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/app-config.token';
import type { AppConfig } from '../config/env.validation';
import { EncryptionService } from './encryption.service';
import { KEY_PROVIDER, type KeyProvider, StaticKeyProvider } from './key-provider';

@Global()
@Module({
  providers: [
    {
      provide: KEY_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): KeyProvider => new StaticKeyProvider(config.crypto),
    },
    EncryptionService,
  ],
  exports: [EncryptionService],
})
export class CryptoModule {}
