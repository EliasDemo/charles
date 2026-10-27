import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  type OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { IdempotentConsumerStore } from '../../common/outbox/idempotent-consumer';
import { OutboxDispatcher } from '../../common/outbox/outbox.dispatcher';
import { type OutboxMessage, OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { addDays, localDateOf } from '../availability/engine/local-time';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';

/** Días hacia adelante en que se puede anotar (igual que el calendario de reservas). */
const HORIZON_DAYS = 30;
/** Inscripciones activas por persona a la vez. */
const MAX_ACTIVE = 5;
/** A cuántos anotados se avisa por cada turno liberado (los primeros en llegar). */
const NOTIFY_PER_SLOT = 3;
export const WAITLIST_EVENT = 'waitlist.slot_freed';
const CONSUMER = 'waitlist';

// ───────────── DTOs ─────────────

export class JoinWaitlistDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceId!: string;

  @ApiProperty({ example: '2026-11-05', description: 'Día local de la barbería (hasta 30 días).' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo con este barbero. Sin él: cualquiera.',
  })
  @IsOptional()
  @IsUUID()
  barberId?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1439,
    description: 'Desde (minutos desde la medianoche, hora local).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  fromMinute?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 1440,
    description: 'Hasta (minutos desde la medianoche, hora local).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  toMinute?: number;
}

export class WaitlistEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) barbershopId!: string;
  @ApiProperty() barbershopName!: string;
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() serviceName!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) barberId!: string | null;
  @ApiProperty({ type: String, nullable: true }) barberName!: string | null;
  @ApiProperty({ example: '2026-11-05' }) date!: string;
  @ApiProperty({ type: Number, nullable: true }) fromMinute!: number | null;
  @ApiProperty({ type: Number, nullable: true }) toMinute!: number | null;
  @ApiProperty({
    enum: ['ACTIVE', 'NOTIFIED', 'CANCELLED', 'EXPIRED'],
    description: 'NOTIFIED: ya se le avisó de un turno libre (reserva normalmente desde la app).',
  })
  status!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) notifiedAt!: Date | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

const entryInclude = {
  barbershop: { select: { name: true } },
  service: { select: { name: true } },
  barber: { select: { displayName: true } },
} as const;

type EntryRow = {
  id: string;
  barbershopId: string;
  serviceId: string;
  barberId: string | null;
  date: Date;
  fromMinute: number | null;
  toMinute: number | null;
  status: string;
  notifiedAt: Date | null;
  createdAt: Date;
  barbershop: { name: string };
  service: { name: string };
  barber: { displayName: string } | null;
};

const toDto = (r: EntryRow): WaitlistEntryDto => ({
  id: r.id,
  barbershopId: r.barbershopId,
  barbershopName: r.barbershop.name,
  serviceId: r.serviceId,
  serviceName: r.service.name,
  barberId: r.barberId,
  barberName: r.barber?.displayName ?? null,
  date: r.date.toISOString().slice(0, 10),
  fromMinute: r.fromMinute,
  toMinute: r.toMinute,
  status: r.status,
  notifiedAt: r.notifiedAt,
  createdAt: r.createdAt,
});

const invalid = (field: string, constraint: string, message: string): AppException =>
  new AppException(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, [
    { field, constraints: [constraint] },
  ]);

// ───────────── Servicio ─────────────

/**
 * Lista de espera: el cliente se anota para un día (y, si quiere, un barbero y una franja). Cuando
 * una reserva de ese día se cancela o vence, se avisa a los primeros anotados cuya franja coincide.
 * El aviso no aparta el turno: lo toma quien reserve primero.
 */
@Injectable()
export class WaitlistService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly store: IdempotentConsumerStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register({
      name: CONSUMER,
      types: ['booking.cancelled', 'booking.expired'],
      handle: async (message) => {
        await this.store.runOnce(CONSUMER, message.id, () => this.onSlotFreed(message));
      },
    });
  }

  async join(
    userId: string,
    barbershopId: string,
    dto: JoinWaitlistDto,
  ): Promise<WaitlistEntryDto> {
    await this.access.requirePublic(barbershopId);
    const shop = await this.prisma.barbershop.findUniqueOrThrow({
      where: { id: barbershopId },
      select: { timezone: true },
    });
    const today = localDateOf(this.clock.now(), shop.timezone);
    if (dto.date < today || dto.date > addDays(today, HORIZON_DAYS)) {
      throw invalid(
        'date',
        'withinHorizon',
        `Elige un día entre hoy y los próximos ${HORIZON_DAYS} días.`,
      );
    }
    if (
      dto.fromMinute !== undefined &&
      dto.toMinute !== undefined &&
      dto.fromMinute >= dto.toMinute
    ) {
      throw invalid('toMinute', 'afterFrom', 'La franja debe terminar después de empezar.');
    }
    const service = await this.prisma.service.findFirst({
      where: { id: dto.serviceId, barbershopId, deletedAt: null, isAvailable: true },
      select: { id: true },
    });
    if (!service) throw invalid('serviceId', 'exists', 'El servicio no existe en esta barbería.');
    if (dto.barberId) {
      const barber = await this.prisma.barber.findFirst({
        where: { id: dto.barberId, barbershopId, deletedAt: null, endedAt: null, isActive: true },
        select: { id: true },
      });
      if (!barber) throw invalid('barberId', 'exists', 'El barbero no atiende en esta barbería.');
    }
    await this.expireStale(userId);
    const date = new Date(`${dto.date}T00:00:00Z`);
    const existing = await this.prisma.waitlistEntry.findFirst({
      where: { userId, barbershopId, serviceId: dto.serviceId, date, status: 'ACTIVE' },
      include: entryInclude,
    });
    if (existing) return toDto(existing);
    const active = await this.prisma.waitlistEntry.count({ where: { userId, status: 'ACTIVE' } });
    if (active >= MAX_ACTIVE) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `Puedes estar en ${MAX_ACTIVE} listas de espera a la vez. Sal de alguna para anotarte en otra.`,
        HttpStatus.CONFLICT,
      );
    }
    const row = await this.prisma.waitlistEntry.create({
      data: {
        userId,
        barbershopId,
        serviceId: dto.serviceId,
        barberId: dto.barberId ?? null,
        date,
        fromMinute: dto.fromMinute ?? null,
        toMinute: dto.toMinute ?? null,
      },
      include: entryInclude,
    });
    return toDto(row);
  }

  async mine(userId: string): Promise<WaitlistEntryDto[]> {
    await this.expireStale(userId);
    const rows = await this.prisma.waitlistEntry.findMany({
      where: { userId, status: { in: ['ACTIVE', 'NOTIFIED'] } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      include: entryInclude,
      take: 50,
    });
    return rows.map(toDto);
  }

  async leave(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.waitlistEntry.updateMany({
      where: { id, userId, status: { in: ['ACTIVE', 'NOTIFIED'] } },
      data: { status: 'CANCELLED' },
    });
    if (!count) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No estás en esa lista de espera.',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /** Las inscripciones de días ya pasados vencen (en la hora de cada barbería). */
  private async expireStale(userId: string): Promise<void> {
    const yesterday = new Date(this.clock.now() - 86_400_000).toISOString().slice(0, 10);
    await this.prisma.waitlistEntry.updateMany({
      where: { userId, status: 'ACTIVE', date: { lt: new Date(`${yesterday}T00:00:00Z`) } },
      data: { status: 'EXPIRED' },
    });
  }

  /** Una reserva confirmada o pendiente se canceló o venció: avisa a los primeros anotados. */
  async onSlotFreed(message: OutboxMessage): Promise<void> {
    const bookingId =
      typeof message.payload.bookingId === 'string' ? message.payload.bookingId : null;
    if (!bookingId) return;
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        barbershopId: true,
        barberId: true,
        startAt: true,
        barbershop: { select: { timezone: true } },
      },
    });
    if (!booking || booking.startAt.getTime() <= this.clock.now()) return;
    const tz = booking.barbershop.timezone;
    const localDate = localDateOf(booking.startAt.getTime(), tz);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(booking.startAt)
      .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    const candidates = await this.prisma.waitlistEntry.findMany({
      where: {
        barbershopId: booking.barbershopId,
        date: new Date(`${localDate}T00:00:00Z`),
        status: 'ACTIVE',
        OR: [{ barberId: null }, { barberId: booking.barberId }],
        AND: [
          { OR: [{ fromMinute: null }, { fromMinute: { lte: minute } }] },
          { OR: [{ toMinute: null }, { toMinute: { gt: minute } }] },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: NOTIFY_PER_SLOT,
      select: { id: true },
    });
    if (!candidates.length) return;
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      for (const c of candidates) {
        const { count } = await tx.waitlistEntry.updateMany({
          where: { id: c.id, status: 'ACTIVE' },
          data: { status: 'NOTIFIED', notifiedAt: now },
        });
        if (count) {
          await this.outbox.publish(tx, WAITLIST_EVENT, {
            entryId: c.id,
            startAt: booking.startAt.toISOString(),
          });
        }
      }
    });
  }
}

// ───────────── Controlador ─────────────

const uuid = new ParseUUIDPipe();

@ApiTags('waitlist')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post('barbershops/:id/waitlist')
  @ApiOperation({
    summary: 'Anotarme en la lista de espera de un día',
    description:
      'Si una reserva de ese día se cancela o vence, te avisamos (push y en la app). El aviso no ' +
      'aparta el turno: resérvalo apenas lo recibas. Idempotente por servicio y día.',
  })
  @ApiCreatedResponse({ type: WaitlistEntryDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'Límite de 5 listas activas.' })
  join(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: JoinWaitlistDto,
  ): Promise<WaitlistEntryDto> {
    return this.waitlist.join(user.id, id, dto);
  }

  @Get('me/waitlist')
  @ApiOperation({ summary: 'Mis listas de espera (activas y avisadas)' })
  @ApiOkResponse({ type: [WaitlistEntryDto] })
  mine(@CurrentUser() user: AuthUser): Promise<WaitlistEntryDto[]> {
    return this.waitlist.mine(user.id);
  }

  @Delete('me/waitlist/:entryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Salir de una lista de espera' })
  @ApiNoContentResponse()
  leave(@CurrentUser() user: AuthUser, @Param('entryId', uuid) entryId: string): Promise<void> {
    return this.waitlist.leave(user.id, entryId);
  }
}

@Module({
  imports: [BarbershopAccessModule],
  controllers: [WaitlistController],
  providers: [WaitlistService],
})
export class WaitlistModule {}
