import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { DevicesService } from './devices.service';

/** Tokens de dispositivo (Fase 10). Separado para que la autenticación los borre al cerrar sesión. */
@Module({
  imports: [SettingsModule],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
