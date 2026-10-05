import { Body, Controller, Get, Module, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../src/common/auth/auth-user';
import { Public } from '../../src/common/auth/public.decorator';
import { Roles } from '../../src/common/auth/roles.decorator';

export const PROBE_LIMIT = 3;

class EchoDto {
  @IsString()
  @MaxLength(50)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}

/** Endpoints solo para pruebas e2e de la infraestructura común. */
@Public()
@Controller('test-probe')
class TestProbeController {
  @Post('echo')
  echo(@Body() dto: EchoDto): EchoDto {
    return dto;
  }

  @Get('boom')
  boom(): never {
    throw new Error('detalle interno que no debe filtrarse');
  }

  @Throttle({ default: { limit: PROBE_LIMIT, ttl: 60_000 } })
  @Get('limited')
  limited(@Req() req: Request): { ip: string | undefined } {
    return { ip: req.ip };
  }
}

/** Endpoints privados de prueba: autenticación y roles. */
@Controller('test-probe/private')
class PrivateProbeController {
  @Get('whoami')
  whoami(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Roles('SUPPORT')
  @Get('support-only')
  supportOnly(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [TestProbeController, PrivateProbeController] })
export class TestProbeModule {}
