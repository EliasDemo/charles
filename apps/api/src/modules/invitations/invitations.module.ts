import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BarbersModule } from '../barbers/barbers.module';
import { BarbershopsModule } from '../barbershops/barbershops.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { InvitationsController } from './invitations.controller';
import { INVITATIONS_QUEUE } from './invitations.jobs';
import { InvitationsProcessor } from './invitations.processor';
import { InvitationsService } from './invitations.service';

/** Invitaciones a responsables y vinculación de barberos (depende de barbershops y barbers). */
@Module({
  imports: [
    AuthModule,
    BarbershopsModule,
    BarbersModule,
    UsersModule,
    SettingsModule,
    BullModule.registerQueue({ name: INVITATIONS_QUEUE }),
  ],
  controllers: [InvitationsController],
  providers: [InvitationsService, InvitationsProcessor],
})
export class InvitationsModule {}
