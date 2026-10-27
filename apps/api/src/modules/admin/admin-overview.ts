import { Controller, Get, Inject, Injectable, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { DateTime } from 'luxon';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { AdminAccessGuard, CurrentStaff, type StaffActor, SupportOrAdmin } from './admin-access';

/** Secciones de la web de administración y quién las ve. */
export const ADMIN_SECTIONS = {
  SUPPORT: [
    'dashboard',
    'users',
    'barbershops',
    'bookings',
    'refunds',
    'cancellation-reviews',
    'moderation',
    'tickets',
    'message-reports',
    'community',
  ],
  ADMIN_ONLY: [
    'roles',
    'settings',
    'catalog',
    'promotions',
    'featured',
    'sponsors',
    'plans',
    'subscriptions',
    'balances',
    'system',
    'audit',
    'staff',
  ],
} as const;

const DEFAULT_ZONE = 'America/Lima';

export class AdminMeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ type: [String], example: ['SUPPORT', 'ADMIN'] })
  roles!: string[];

  @ApiProperty({ enum: ['ADMIN', 'SUPPORT'], description: 'Rol con el que actúa.' })
  role!: 'ADMIN' | 'SUPPORT';

  @ApiProperty({
    type: [String],
    description:
      'Secciones que puede ver: dashboard, users, barbershops, bookings, refunds, ' +
      'cancellation-reviews, moderation, tickets; solo ADMIN: roles, settings, catalog.',
  })
  sections!: string[];
}

export class AdminDashboardDto {
  @ApiProperty({ description: 'Barberías esperando revisión (alta o marcadas).' })
  barbershopsPendingReview!: number;

  @ApiProperty({ description: 'Tickets abiertos o en proceso.' })
  ticketsOpen!: number;

  @ApiProperty({ description: 'Valoraciones o respuestas en revisión por reportes.' })
  reviewsReported!: number;

  @ApiProperty({ description: 'Fotos con reportes abiertos.' })
  imagesReported!: number;

  @ApiProperty({ description: 'Reportes de barberías abiertos.' })
  barbershopReportsOpen!: number;

  @ApiProperty({ description: 'Cancelaciones de barberías por revisar.' })
  cancellationReviewsPending!: number;

  @ApiProperty({ description: 'Reembolsos fallidos.' })
  refundsFailed!: number;

  @ApiProperty({ description: 'Reservas de hoy (hora de Lima), sin canceladas ni vencidas.' })
  bookingsToday!: number;

  @ApiProperty()
  generatedAt!: Date;
}

@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async me(staff: StaffActor): Promise<AdminMeDto> {
    const names = await this.users.fullNames([staff.id]);
    const isAdmin = staff.role === 'ADMIN';
    return {
      id: staff.id,
      fullName: names.get(staff.id) ?? '',
      roles: staff.roles,
      role: staff.role,
      sections: [...ADMIN_SECTIONS.SUPPORT, ...(isAdmin ? ADMIN_SECTIONS.ADMIN_ONLY : [])],
    };
  }

  async dashboard(): Promise<AdminDashboardDto> {
    const now = this.clock.now();
    const day = DateTime.fromMillis(now, { zone: DEFAULT_ZONE }).startOf('day');
    const [
      barbershopsPendingReview,
      ticketsOpen,
      reviewsReported,
      imagesReported,
      barbershopReportsOpen,
      cancellationReviewsPending,
      refundsFailed,
      bookingsToday,
    ] = await Promise.all([
      this.prisma.barbershop.count({
        where: {
          deletedAt: null,
          OR: [{ status: 'PENDING_REVIEW' }, { flaggedReason: { not: null } }],
        },
      }),
      this.prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      this.prisma.review.count({
        where: {
          deletedAt: null,
          OR: [{ status: 'UNDER_REVIEW' }, { responseStatus: 'UNDER_REVIEW' }],
        },
      }),
      this.prisma.image.count({
        where: { deletedAt: null, reports: { some: { status: { not: 'RESOLVED' } } } },
      }),
      this.prisma.barbershopReport.count({ where: { status: { not: 'RESOLVED' } } }),
      this.prisma.barbershopCancellationReview.count({ where: { status: 'PENDING_REVIEW' } }),
      this.prisma.refund.count({ where: { status: 'FAILED' } }),
      this.prisma.booking.count({
        where: {
          startAt: { gte: day.toJSDate(), lt: day.plus({ days: 1 }).toJSDate() },
          status: { notIn: ['CANCELLED', 'EXPIRED'] },
        },
      }),
    ]);
    return {
      barbershopsPendingReview,
      ticketsOpen,
      reviewsReported,
      imagesReported,
      barbershopReportsOpen,
      cancellationReviewsPending,
      refundsFailed,
      bookingsToday,
      generatedAt: new Date(now),
    };
  }
}

/** Para la web de administración: quién soy y la portada. */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@SupportOrAdmin()
@UseGuards(AdminAccessGuard)
@Controller('admin')
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get('me')
  @ApiOperation({ summary: 'Web de administración: quién soy, mis roles y mis secciones' })
  @ApiOkResponse({ type: AdminMeDto })
  me(@CurrentStaff() staff: StaffActor): Promise<AdminMeDto> {
    return this.overview.me(staff);
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Web de administración: contadores de la portada' })
  @ApiOkResponse({ type: AdminDashboardDto })
  dashboard(): Promise<AdminDashboardDto> {
    return this.overview.dashboard();
  }
}
