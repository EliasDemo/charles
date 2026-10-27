import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/app-config.token';
import { type AppConfig, MailerDriver } from '../config/env.validation';
import { FakeMailer } from './fake-mailer';
import { MAILER } from './mailer';
import { ResendMailer } from './resend-mailer';

/** MAILER_DRIVER: `fake` (desarrollo y pruebas; prohibido en producción) o `resend`. */
@Global()
@Module({
  providers: [
    FakeMailer,
    ResendMailer,
    {
      provide: MAILER,
      inject: [APP_CONFIG, FakeMailer, ResendMailer],
      useFactory: (config: AppConfig, fake: FakeMailer, resend: ResendMailer) =>
        config.mail.driver === MailerDriver.Resend ? resend : fake,
    },
  ],
  exports: [MAILER, FakeMailer],
})
export class MailModule {}
