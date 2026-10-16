import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { AdminAccessGuard, AdminOnly, CurrentStaff, type StaffActor } from '../admin/admin-access';
import {
  AdminPromotionsQueryDto,
  CreateCouponDto,
  CreatePromotionDto,
  PromotionDto,
  PublicPromotionDto,
  UpdatePromotionDto,
} from './dto/promotion.dto';
import { PromotionsService } from './promotions.service';

const uuid = new ParseUUIDPipe();

/** Fase 13: promociones de una barbería (OWNER o MANAGER) y las vigentes, para los clientes. */
@ApiTags('promotions')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('barbershops/:id/promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Public()
  @Get('active')
  @ApiOperation({
    summary: 'Promociones automáticas vigentes de la barbería (y las de Charles)',
    description: 'Para mostrar en el perfil de la barbería. Los cupones no aparecen.',
  })
  @ApiOkResponse({ type: [PublicPromotionDto] })
  active(@Param('id', uuid) id: string): Promise<PublicPromotionDto[]> {
    return this.promotions.activeForBarbershop(id);
  }

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: promociones de la barbería, con canjes y cupones' })
  @ApiOkResponse({ type: [PromotionDto] })
  list(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<PromotionDto[]> {
    return this.promotions.listForBarbershop(user.id, id);
  }

  @Post()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'OWNER o MANAGER: crear una promoción (la asume la barbería)',
    description:
      'Con serviceId, solo para ese servicio. Un solo descuento por reserva: el mayor entre los ' +
      'que apliquen.',
  })
  @ApiCreatedResponse({ type: PromotionDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CreatePromotionDto,
    @Req() req: Request,
  ): Promise<PromotionDto> {
    return this.promotions.createForBarbershop({ userId: user.id, ip: req.ip }, id, dto);
  }

  @Patch(':promotionId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: editar nombre, fin, topes, o pausar y reanudar' })
  @ApiOkResponse({ type: PromotionDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('promotionId', uuid) promotionId: string,
    @Body() dto: UpdatePromotionDto,
    @Req() req: Request,
  ): Promise<PromotionDto> {
    return this.promotions.updateForBarbershop(
      { userId: user.id, ip: req.ip },
      id,
      promotionId,
      dto,
    );
  }

  @Post(':promotionId/coupons')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: agregar un código de cupón' })
  @ApiCreatedResponse({ type: PromotionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'COUPON_CODE_TAKEN' })
  addCoupon(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('promotionId', uuid) promotionId: string,
    @Body() dto: CreateCouponDto,
    @Req() req: Request,
  ): Promise<PromotionDto> {
    return this.promotions.addCouponForBarbershop(
      { userId: user.id, ip: req.ip },
      id,
      promotionId,
      dto,
    );
  }

  @Delete(':promotionId/coupons/:couponId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: retirar un cupón (los canjes hechos se conservan)' })
  @ApiOkResponse({ type: PromotionDto })
  removeCoupon(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('promotionId', uuid) promotionId: string,
    @Param('couponId', uuid) couponId: string,
    @Req() req: Request,
  ): Promise<PromotionDto> {
    return this.promotions.removeCouponForBarbershop(
      { userId: user.id, ip: req.ip },
      id,
      promotionId,
      couponId,
    );
  }
}

/** Fase 13: promociones de Charles y control de todas (solo ADMIN). */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@AdminOnly()
@UseGuards(AdminAccessGuard)
@Controller('admin/promotions')
export class PromotionsAdminController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @ApiOperation({ summary: 'Solo ADMIN: promociones (las 200 más recientes), con canjes' })
  @ApiOkResponse({ type: [PromotionDto] })
  list(@Query() query: AdminPromotionsQueryDto): Promise<PromotionDto[]> {
    return this.promotions.adminList(query);
  }

  @Post()
  @ApiOperation({ summary: 'Solo ADMIN: crear una promoción de Charles (la asume Charles)' })
  @ApiCreatedResponse({ type: PromotionDto })
  create(
    @CurrentStaff() staff: StaffActor,
    @Body() dto: CreatePromotionDto,
    @Req() req: Request,
  ): Promise<PromotionDto> {
    return this.promotions.createPlatform({ userId: staff.id, ip: req.ip }, dto);
  }

  @Patch(':promotionId')
  @ApiOperation({
    summary: 'Solo ADMIN: editar o pausar cualquier promoción (también de barberías)',
  })
  @ApiOkResponse({ type: PromotionDto })
  update(
    @CurrentStaff() staff: StaffActor,
    @Param('promotionId', uuid) promotionId: string,
    @Body() dto: UpdatePromotionDto,
    @Req() req: Request,
  ): Promise<PromotionDto> {
    return this.promotions.adminUpdate({ userId: staff.id, ip: req.ip }, promotionId, dto);
  }

  @Post(':promotionId/coupons')
  @ApiOperation({ summary: 'Solo ADMIN: agregar un código de cupón' })
  @ApiCreatedResponse({ type: PromotionDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  addCoupon(
    @CurrentStaff() staff: StaffActor,
    @Param('promotionId', uuid) promotionId: string,
    @Body() dto: CreateCouponDto,
    @Req() req: Request,
  ): Promise<PromotionDto> {
    return this.promotions.adminAddCoupon({ userId: staff.id, ip: req.ip }, promotionId, dto);
  }

  @Delete(':promotionId/coupons/:couponId')
  @ApiOperation({ summary: 'Solo ADMIN: retirar un cupón' })
  @ApiOkResponse({ type: PromotionDto })
  removeCoupon(
    @CurrentStaff() staff: StaffActor,
    @Param('promotionId', uuid) promotionId: string,
    @Param('couponId', uuid) couponId: string,
    @Req() req: Request,
  ): Promise<PromotionDto> {
    return this.promotions.adminRemoveCoupon(
      { userId: staff.id, ip: req.ip },
      promotionId,
      couponId,
    );
  }
}
