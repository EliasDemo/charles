import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_CONFIG } from './app-config.token';
import { AppConfig, validateEnv } from './env.validation';

/**
 * Carga `.env` (salvo en pruebas, donde todo viene del entorno) y expone la
 * configuración validada como `AppConfig` (inyectable con `@Inject(APP_CONFIG)`).
 * Si la validación falla, la aplicación no arranca.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: async (): Promise<AppConfig> => {
        await ConfigModule.envVariablesLoaded;
        return validateEnv(process.env);
      },
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
