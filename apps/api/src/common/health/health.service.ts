import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { ComponentStatus, HealthChecksDto, HealthResponseDto } from './dto/health-response.dto';

const CHECK_TIMEOUT_MS = 2_000;

async function probe(check: () => Promise<unknown>): Promise<ComponentStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return ComponentStatus.Up;
  } catch {
    return ComponentStatus.Down;
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthResponseDto> {
    const [database, redis] = await Promise.all([
      probe(() => this.prisma.$queryRaw`SELECT 1`),
      probe(() => this.redis.ping()),
    ]);
    const checks: HealthChecksDto = { database, redis };

    if (database !== ComponentStatus.Up || redis !== ComponentStatus.Up) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'El servicio no está disponible temporalmente.',
        HttpStatus.SERVICE_UNAVAILABLE,
        [checks],
      );
    }
    return { status: 'ok', checks };
  }
}
