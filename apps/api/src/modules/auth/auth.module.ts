import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { AccountRecoveryService } from './account-recovery.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginAttemptsService } from './login-attempts.service';
import { AUTH_MAIL_QUEUE } from './mail/auth-mail.jobs';
import { AuthMailProcessor } from './mail/auth-mail.processor';
import { AuthMailProducer } from './mail/auth-mail.producer';
import { OneTimeCodesService } from './one-time-codes.service';
import { SessionsService } from './sessions.service';

@Module({
  imports: [UsersModule, SettingsModule, BullModule.registerQueue({ name: AUTH_MAIL_QUEUE })],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccountRecoveryService,
    SessionsService,
    LoginAttemptsService,
    OneTimeCodesService,
    AuthMailProducer,
    AuthMailProcessor,
  ],
  // Reutilizados por otros módulos para códigos de invitación (mismas reglas de bloqueo).
  exports: [LoginAttemptsService, SessionsService],
})
export class AuthModule {}
