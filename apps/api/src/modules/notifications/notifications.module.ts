import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../common/config/app-config.token';
import { type AppConfig, PushDriver } from '../../common/config/env.validation';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { DevicesModule } from './devices.module';
import { NotificationsController } from './notifications.controller';
import {
  NOTIFICATIONS_QUEUE,
  NotificationsProcessor,
  NotificationsScheduler,
} from './notifications.job';
import { NotificationsService } from './notifications.service';
import { ExpoPushSender, FakePushSender, PUSH_SENDER } from './push-sender';

/**
 * Notificaciones (Fase 10, RF-NOT-001…004): push (Expo), correo y bandeja en la app, a partir de
 * los eventos del outbox. `PUSH_DRIVER=fake` en desarrollo y pruebas (prohibido en producción).
 */
@Module({
  imports: [
    DevicesModule,
    UsersModule,
    SettingsModule,
    BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsProcessor,
    NotificationsScheduler,
    FakePushSender,
    {
      provide: PUSH_SENDER,
      inject: [APP_CONFIG, FakePushSender],
      useFactory: (config: AppConfig, fake: FakePushSender) =>
        config.push.driver === PushDriver.Expo ? new ExpoPushSender(config) : fake,
    },
  ],
  exports: [NotificationsService, FakePushSender],
})
export class NotificationsModule {}
