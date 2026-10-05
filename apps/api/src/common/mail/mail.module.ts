import { Global, Module } from '@nestjs/common';
import { FakeMailer } from './fake-mailer';
import { MAILER } from './mailer';

/** MAILER_DRIVER solo admite `fake` por ahora (validado al arrancar; prohibido en producción). */
@Global()
@Module({
  providers: [FakeMailer, { provide: MAILER, useExisting: FakeMailer }],
  exports: [MAILER, FakeMailer],
})
export class MailModule {}
