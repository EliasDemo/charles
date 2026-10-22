import { Controller, Get, Injectable, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';

export const READINESS_CODES = [
  'NOT_PUBLISHED',
  'NO_BUSINESS_HOURS',
  'NO_SERVICES',
  'NO_ACTIVE_BARBERS',
  'BARBER_WITHOUT_SERVICES',
  'INVITATION_PENDING',
  'BARBERS_SUSPENDED_BY_PLAN',
] as const;
export type ReadinessCode = (typeof READINESS_CODES)[number];

export class ReadinessIssueDto {
  @ApiProperty({ enum: READINESS_CODES })
  code!: ReadinessCode;

  @ApiProperty({
    enum: ['BLOCKING', 'WARNING'],
    description: 'BLOCKING impide reservar; WARNING es un aviso.',
  })
  severity!: 'BLOCKING' | 'WARNING';

  @ApiProperty({ description: 'Texto para mostrar al dueño.' })
  message!: string;

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  barberId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  barberName!: string | null;
}

export class ReadinessDto {
  @ApiProperty({
    description:
      'Se puede reservar: publicada, con horario, servicios y al menos un barbero listo.',
  })
  ready!: boolean;

  @ApiProperty({
    description: 'Barberos que ya reciben reservas (activos y con servicios).',
  })
  bookableBarbers!: number;

  @ApiProperty({ type: [ReadinessIssueDto] })
  issues!: ReadinessIssueDto[];
}

const STATUS_TEXT: Record<string, string> = {
  DRAFT: 'Tu barbería está en borrador: complétala y envíala a revisión.',
  PENDING_REVIEW: 'Tu barbería está en revisión: te avisaremos al aprobarla.',
  CHANGES_REQUESTED: 'Soporte pidió cambios: corrígelos y reenvía a revisión.',
  SUSPENDED: 'Tu barbería está suspendida: comunícate con soporte.',
  TEMPORARILY_CLOSED: 'Tu barbería está cerrada temporalmente.',
};

/**
 * "Lista para reservar" (pedido de la app): por qué una barbería no muestra turnos, en un solo
 * lugar (antes la app lo deducía de varios endpoints).
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
  ) {}

  async check(userId: string, barbershopId: string): Promise<ReadinessDto> {
    await this.access.requireMember(userId, barbershopId);
    const shop = await this.prisma.barbershop.findUniqueOrThrow({
      where: { id: barbershopId },
      select: { status: true },
    });
    const [hours, services, barbers, suspended, pending] = await Promise.all([
      this.prisma.businessHour.count({ where: { barbershopId } }),
      this.prisma.service.count({ where: { barbershopId, deletedAt: null, isAvailable: true } }),
      this.prisma.barber.findMany({
        where: { barbershopId, deletedAt: null, endedAt: null, isActive: true },
        select: {
          id: true,
          displayName: true,
          userId: true,
          _count: { select: { services: true } },
        },
      }),
      this.prisma.barber.count({
        where: { barbershopId, deletedAt: null, planSuspendedAt: { not: null } },
      }),
      this.prisma.barbershopInvitation.findMany({
        where: { barbershopId, acceptedAt: null, revokedAt: null, barberId: { not: null } },
        select: { barberId: true },
      }),
    ]);
    const issues: ReadinessIssueDto[] = [];
    const add = (
      code: ReadinessCode,
      severity: 'BLOCKING' | 'WARNING',
      message: string,
      barber?: { id: string; displayName: string },
    ) =>
      issues.push({
        code,
        severity,
        message,
        barberId: barber?.id ?? null,
        barberName: barber?.displayName ?? null,
      });

    if (shop.status !== 'OPEN')
      add(
        'NOT_PUBLISHED',
        'BLOCKING',
        STATUS_TEXT[shop.status] ?? 'Tu barbería no está publicada.',
      );
    if (hours === 0)
      add('NO_BUSINESS_HOURS', 'BLOCKING', 'Configura el horario de atención de la barbería.');
    if (services === 0) add('NO_SERVICES', 'BLOCKING', 'Agrega al menos un servicio disponible.');
    if (barbers.length === 0)
      add('NO_ACTIVE_BARBERS', 'BLOCKING', 'Agrega al menos un barbero activo.');
    const invited = new Set(pending.map((p) => p.barberId));
    let bookable = 0;
    for (const b of barbers) {
      // Sin horario propio, el barbero atiende en el horario de la barbería.
      const ready = b._count.services > 0;
      if (ready) bookable++;
      if (b._count.services === 0)
        add(
          'BARBER_WITHOUT_SERVICES',
          'WARNING',
          `${b.displayName} no tiene servicios asignados.`,
          b,
        );
      if (!b.userId && invited.has(b.id)) {
        add(
          'INVITATION_PENDING',
          'WARNING',
          `${b.displayName} aún no acepta la invitación (igual puede recibir reservas).`,
          b,
        );
      }
    }
    if (barbers.length > 0 && bookable === 0) {
      add('NO_ACTIVE_BARBERS', 'BLOCKING', 'Ningún barbero tiene servicios asignados.');
    }
    if (suspended > 0) {
      add(
        'BARBERS_SUSPENDED_BY_PLAN',
        'WARNING',
        `${suspended} barbero(s) inactivos por el límite de tu plan.`,
      );
    }
    return {
      ready: !issues.some((i) => i.severity === 'BLOCKING'),
      bookableBarbers: bookable,
      issues,
    };
  }
}

@ApiTags('availability')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('barbershops/:id/readiness')
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  @ApiOperation({ summary: 'OWNER o MANAGER: ¿se puede reservar? y, si no, por qué' })
  @ApiOkResponse({ type: ReadinessDto })
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReadinessDto> {
    return this.readiness.check(user.id, id);
  }
}
