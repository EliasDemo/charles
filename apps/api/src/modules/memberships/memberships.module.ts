import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { PaymentsModule } from '../payments/payments.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import {
  CreateMembershipPlanDto,
  ManagedMembershipPlanDto,
  MembershipDto,
  MembershipPlanDto,
  PayWithMembershipDto,
  ShopMemberDto,
  UpdateMembershipPlanDto,
} from './dto/membership.dto';
import { MembershipsService } from './memberships.service';

const uuid = new ParseUUIDPipe();

/** Fase 16: membresías que ofrece una barbería. */
@ApiTags('memberships')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('barbershops/:id')
export class BarbershopMembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Public()
  @Get('membership-plans')
  @ApiOperation({
    summary: 'Membresías a la venta (vacío si el plan de la barbería no las incluye)',
  })
  @ApiOkResponse({ type: [MembershipPlanDto] })
  publicPlans(@Param('id', uuid) id: string): Promise<MembershipPlanDto[]> {
    return this.memberships.publicPlans(id);
  }

  @Get('membership-plans/manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: todas sus membresías, con miembros activos' })
  @ApiOkResponse({ type: [ManagedMembershipPlanDto] })
  managed(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<ManagedMembershipPlanDto[]> {
    return this.memberships.managedPlans(user.id, id);
  }

  @Post('membership-plans')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Solo OWNER: crear una membresía (si el plan lo incluye)' })
  @ApiCreatedResponse({ type: ManagedMembershipPlanDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'PLAN_FEATURE_NOT_INCLUDED' })
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CreateMembershipPlanDto,
    @Req() req: Request,
  ): Promise<ManagedMembershipPlanDto> {
    return this.memberships.createPlan({ userId: user.id, ip: req.ip }, id, dto);
  }

  @Patch('membership-plans/:planId')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Solo OWNER: editar o dejar de vender una membresía (las vigentes siguen)',
  })
  @ApiOkResponse({ type: ManagedMembershipPlanDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('planId', uuid) planId: string,
    @Body() dto: UpdateMembershipPlanDto,
    @Req() req: Request,
  ): Promise<ManagedMembershipPlanDto> {
    return this.memberships.updatePlan({ userId: user.id, ip: req.ip }, id, planId, dto);
  }

  @Get('membership-members')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: clientes con membresía vigente y sus créditos' })
  @ApiOkResponse({ type: [ShopMemberDto] })
  members(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<ShopMemberDto[]> {
    return this.memberships.members(user.id, id);
  }
}

/** Fase 16: membresías del cliente y pago de reservas con crédito. */
@ApiTags('memberships')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class MyMembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get('users/me/memberships')
  @ApiOperation({ summary: 'Mis membresías (sin las vencidas), con créditos disponibles' })
  @ApiOkResponse({ type: [MembershipDto] })
  mine(@CurrentUser() user: AuthUser): Promise<MembershipDto[]> {
    return this.memberships.mine(user.id);
  }

  @Post('membership-plans/:planId/subscribe')
  @ApiOperation({
    summary: 'Suscribirse a una membresía',
    description:
      'Devuelve checkoutUrl (pasarela): la app lo abre. Al pagarse, llegan los créditos.',
  })
  @ApiCreatedResponse({ type: MembershipDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto, description: 'BILLING_UNAVAILABLE' })
  subscribe(
    @CurrentUser() user: AuthUser,
    @Param('planId', uuid) planId: string,
  ): Promise<MembershipDto> {
    return this.memberships.subscribe(user.id, planId);
  }

  @Post('users/me/memberships/:membershipId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancelar (los créditos siguen hasta que vencen; sin devolución del mes)',
  })
  @ApiOkResponse({ type: MembershipDto })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('membershipId', uuid) membershipId: string,
  ): Promise<MembershipDto> {
    return this.memberships.cancel(user.id, membershipId);
  }

  @Post('users/me/memberships/:membershipId/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consultar a la pasarela si ya se pagó (al volver del pago)' })
  @ApiOkResponse({ type: MembershipDto })
  sync(
    @CurrentUser() user: AuthUser,
    @Param('membershipId', uuid) membershipId: string,
  ): Promise<MembershipDto> {
    return this.memberships.sync(user.id, membershipId);
  }

  @Post('bookings/:bookingId/pay-with-membership')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pagar una reserva pendiente con un crédito de membresía' })
  @ApiOkResponse({ schema: { properties: { status: { type: 'string', example: 'CONFIRMED' } } } })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'NO_MEMBERSHIP_CREDITS, MEMBERSHIP_NOT_APPLICABLE',
  })
  pay(
    @CurrentUser() user: AuthUser,
    @Param('bookingId', uuid) bookingId: string,
    @Body() dto: PayWithMembershipDto,
  ): Promise<{ status: string }> {
    return this.memberships.payBooking(user.id, bookingId, dto.membershipId);
  }
}

export const MEMBERSHIPS_QUEUE = 'memberships';
const MAINTENANCE_JOB = 'memberships-maintenance';

@Processor(MEMBERSHIPS_QUEUE)
export class MembershipsProcessor extends WorkerHost {
  constructor(private readonly memberships: MembershipsService) {
    super();
  }

  async process(): Promise<void> {
    await this.memberships.runMaintenance();
  }
}

@Injectable()
export class MembershipsScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(MEMBERSHIPS_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    await this.queue.upsertJobScheduler(
      MAINTENANCE_JOB,
      { pattern: '17 * * * *', tz: 'America/Lima' },
      { name: MAINTENANCE_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 } },
    );
  }
}

/** Fase 16: membresías con créditos periódicos. */
@Module({
  imports: [
    BarbershopAccessModule,
    PaymentsModule,
    SettingsModule,
    UsersModule,
    BullModule.registerQueue({ name: MEMBERSHIPS_QUEUE }),
  ],
  controllers: [BarbershopMembershipsController, MyMembershipsController],
  providers: [MembershipsService, MembershipsProcessor, MembershipsScheduler],
  exports: [MembershipsService],
})
export class MembershipsModule {}
