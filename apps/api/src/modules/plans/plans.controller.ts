import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { AdminAccessGuard, AdminOnly, CurrentStaff, type StaffActor } from '../admin/admin-access';
import {
  ActiveBarbersDto,
  AdminPlanDto,
  AdminReasonDto,
  AdminSubscriptionDto,
  AdminSubscriptionsQueryDto,
  BarbershopPlanDto,
  BillingSummaryDto,
  CancelSubscriptionDto,
  CreatePlanDto,
  EntitlementDefinitionDto,
  ExtendSubscriptionDto,
  FeaturedFromPlanDto,
  PlanDto,
  PlansQueryDto,
  PublicPlanBadgesDto,
  SetEntitlementsDto,
  SubscribeDto,
  SubscriptionDto,
  UpdatePlanDto,
  UseFeaturedDaysDto,
} from './dto/plan.dto';
import { EntitlementsService } from './entitlements.service';
import { PlansService } from './plans.service';
import { SubscriptionsService } from './subscriptions.service';

const uuid = new ParseUUIDPipe();

/** Fase 15: planes que se ofrecen (públicos). */
@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Planes que se ofrecen, con sus beneficios' })
  @ApiOkResponse({ type: [PlanDto] })
  list(@Query() query: PlansQueryDto): Promise<PlanDto[]> {
    return this.plans.publicList(query.audience);
  }
}

/** Fase 15: plan y suscripción de una barbería (OWNER contrata y cancela; MANAGER consulta). */
@ApiTags('plans')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('barbershops/:id')
export class BarbershopPlanController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('plan')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: plan vigente, límites y uso' })
  @ApiOkResponse({ type: BarbershopPlanDto })
  plan(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<BarbershopPlanDto> {
    return this.subscriptions.summary(user.id, id);
  }

  @Public()
  @Get('plan/badges')
  @ApiOperation({ summary: 'Insignias públicas del plan (perfil de la barbería)' })
  @ApiOkResponse({ type: PublicPlanBadgesDto })
  badges(@Param('id', uuid) id: string): Promise<PublicPlanBadgesDto> {
    return this.subscriptions.publicBadges(id);
  }

  @Get('subscription')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'OWNER o MANAGER: suscripción vigente o pendiente de pago (null si no hay)',
  })
  @ApiOkResponse({ type: SubscriptionDto })
  current(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<SubscriptionDto | null> {
    return this.subscriptions.currentDto(user.id, id);
  }

  @Post('subscription')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Solo OWNER: contratar un plan de pago',
    description:
      'Crea la suscripción en la pasarela y envía el enlace de pago por correo al dueño. La app no ' +
      'abre el enlace (políticas de Apple y Google). Queda PENDING hasta que el dueño pague.',
  })
  @ApiCreatedResponse({ type: SubscriptionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'SUBSCRIPTION_EXISTS' })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto, description: 'BILLING_UNAVAILABLE' })
  subscribe(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: SubscribeDto,
    @Req() req: Request,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.subscribe({ userId: user.id, ip: req.ip }, id, dto);
  }

  @Post('subscription/pay-with-balance')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Solo OWNER: pagar con el saldo a favor el periodo siguiente (o recuperar un plan vencido)',
    description:
      'Solo para planes contratados con paymentMethod=BALANCE. 409 INSUFFICIENT_BALANCE si no alcanza.',
  })
  @ApiOkResponse({ type: SubscriptionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'INSUFFICIENT_BALANCE' })
  payWithBalance(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.payWithBalance({ userId: user.id, ip: req.ip }, id);
  }

  @Post('subscription/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Solo OWNER: cancelar (el plan sigue hasta el fin del periodo pagado)' })
  @ApiOkResponse({ type: SubscriptionDto })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CancelSubscriptionDto,
    @Req() req: Request,
  ): Promise<SubscriptionDto> {
    return this.subscriptions.cancel({ userId: user.id, ip: req.ip }, id, dto.reason);
  }

  @Post('subscription/sync')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: consultar a la pasarela si ya se pagó' })
  @ApiOkResponse({ type: SubscriptionDto })
  sync(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<SubscriptionDto | null> {
    return this.subscriptions.sync(user.id, id);
  }

  @Put('plan/active-barbers')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Solo OWNER: elegir qué barberos siguen activos cuando el plan limita la cantidad',
  })
  @ApiOkResponse({ type: BarbershopPlanDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'PLAN_LIMIT_REACHED' })
  activeBarbers(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: ActiveBarbersDto,
  ): Promise<BarbershopPlanDto> {
    return this.subscriptions.chooseActiveBarbers(user.id, id, dto.barberIds);
  }

  @Post('featured')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: usar días destacados incluidos en el plan' })
  @ApiCreatedResponse({ type: FeaturedFromPlanDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'PLAN_LIMIT_REACHED' })
  featured(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: UseFeaturedDaysDto,
    @Req() req: Request,
  ): Promise<FeaturedFromPlanDto> {
    return this.subscriptions.useFeaturedDays({ userId: user.id, ip: req.ip }, id, dto);
  }
}

/** Fase 15: administración de planes (solo ADMIN, con motivo y auditoría). */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@AdminOnly()
@UseGuards(AdminAccessGuard)
@Controller('admin/plans')
export class PlansAdminController {
  constructor(
    private readonly plans: PlansService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Solo ADMIN: todos los planes (también ocultos), con suscripciones vivas',
  })
  @ApiOkResponse({ type: [AdminPlanDto] })
  list(): Promise<AdminPlanDto[]> {
    return this.plans.adminList();
  }

  @Get('entitlements')
  @ApiOperation({ summary: 'Solo ADMIN: catálogo de beneficios (claves y tipo)' })
  @ApiOkResponse({ type: [EntitlementDefinitionDto] })
  catalog(): EntitlementDefinitionDto[] {
    return [...this.entitlements.catalog()];
  }

  @Post()
  @ApiOperation({ summary: 'Solo ADMIN: crear un plan' })
  @ApiCreatedResponse({ type: AdminPlanDto })
  create(@CurrentStaff() staff: StaffActor, @Body() dto: CreatePlanDto): Promise<AdminPlanDto> {
    return this.plans.create(staff.id, dto);
  }

  @Patch(':planId')
  @ApiOperation({
    summary:
      'Solo ADMIN: editar un plan (precio nuevo: las suscripciones vigentes lo pagan desde su renovación)',
  })
  @ApiOkResponse({ type: AdminPlanDto })
  update(
    @CurrentStaff() staff: StaffActor,
    @Param('planId', uuid) planId: string,
    @Body() dto: UpdatePlanDto,
  ): Promise<AdminPlanDto> {
    return this.plans.update(staff.id, planId, dto);
  }

  @Put(':planId/entitlements')
  @ApiOperation({ summary: 'Solo ADMIN: beneficios del plan (reemplaza todos)' })
  @ApiOkResponse({ type: AdminPlanDto })
  setEntitlements(
    @CurrentStaff() staff: StaffActor,
    @Param('planId', uuid) planId: string,
    @Body() dto: SetEntitlementsDto,
  ): Promise<AdminPlanDto> {
    return this.plans.setEntitlements(staff.id, planId, dto);
  }

  @Delete(':planId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Solo ADMIN: eliminar un plan sin suscripciones (si las tiene, ocultarlo)',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto })
  async remove(
    @CurrentStaff() staff: StaffActor,
    @Param('planId', uuid) planId: string,
    @Body() dto: AdminReasonDto,
  ): Promise<void> {
    await this.plans.remove(staff.id, planId, dto.reason);
  }
}

/** Fase 15: suscripciones de todas las barberías (solo ADMIN). */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@AdminOnly()
@UseGuards(AdminAccessGuard)
@Controller('admin/subscriptions')
export class SubscriptionsAdminController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Solo ADMIN: resumen de facturación (MRR, planes, cobros y comisiones del mes)',
  })
  @ApiOkResponse({ type: BillingSummaryDto })
  summary(): Promise<BillingSummaryDto> {
    return this.subscriptions.billingSummary();
  }

  @Get()
  @ApiOperation({ summary: 'Solo ADMIN: suscripciones (las 200 más recientes)' })
  @ApiOkResponse({ type: [AdminSubscriptionDto] })
  list(@Query() query: AdminSubscriptionsQueryDto): Promise<AdminSubscriptionDto[]> {
    return this.subscriptions.adminList(query);
  }

  @Post(':subscriptionId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Solo ADMIN: cancelar de inmediato (la barbería baja al plan gratis)' })
  @ApiOkResponse({ type: AdminSubscriptionDto })
  cancel(
    @CurrentStaff() staff: StaffActor,
    @Param('subscriptionId', uuid) subscriptionId: string,
    @Body() dto: AdminReasonDto,
  ): Promise<AdminSubscriptionDto> {
    return this.subscriptions.adminCancel(staff.id, subscriptionId, dto.reason);
  }

  @Post(':subscriptionId/extend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Solo ADMIN: sumar días de cortesía' })
  @ApiOkResponse({ type: AdminSubscriptionDto })
  extend(
    @CurrentStaff() staff: StaffActor,
    @Param('subscriptionId', uuid) subscriptionId: string,
    @Body() dto: ExtendSubscriptionDto,
  ): Promise<AdminSubscriptionDto> {
    return this.subscriptions.adminExtend(staff.id, subscriptionId, dto.days, dto.reason);
  }
}
