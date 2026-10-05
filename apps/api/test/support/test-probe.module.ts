import { Body, Controller, Get, Module, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../src/common/auth/public.decorator';

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

@Module({ controllers: [TestProbeController] })
export class TestProbeModule {}
