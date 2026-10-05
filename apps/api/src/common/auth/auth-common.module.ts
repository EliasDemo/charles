import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { SessionRevocationStore } from './session-revocation.store';
import { TokenService } from './token.service';

/**
 * Autenticación transversal: verificación de tokens y guards globales.
 * Orden de guards: límite de peticiones (AppModule) → autenticación → roles.
 */
@Global()
@Module({
  providers: [
    TokenService,
    SessionRevocationStore,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenService, SessionRevocationStore],
})
export class AuthCommonModule {}
