import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { BarbersService } from './barbers.service';
import {
  BarberManageDto,
  BarberManagePageDto,
  BarberPublicPageDto,
  CreateBarberDto,
  LinkSelfAsBarberDto,
  MyBarberProfilesDto,
  SetBarberServicesDto,
  UpdateBarberDto,
} from './dto/barber.dto';

const uuid = new ParseUUIDPipe();

@ApiTags('barbers')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class BarbersController {
  constructor(private readonly barbers: BarbersService) {}

  @ApiBearerAuth()
  @Get('me/barber')
  @ApiOperation({
    summary: 'Mis perfiles de barbero, con su barbería (para bloqueos propios y agenda)',
  })
  @ApiOkResponse({ type: MyBarberProfilesDto })
  myProfiles(@CurrentUser() user: AuthUser): Promise<MyBarberProfilesDto> {
    return this.barbers.myProfiles(user.id);
  }

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/barbers')
  @ApiOperation({ summary: 'Barberos activos de una barbería (solo datos públicos)' })
  @ApiOkResponse({ type: BarberPublicPageDto })
  listPublic(
    @Param('id', uuid) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<BarberPublicPageDto> {
    return this.barbers.listPublic(id, query);
  }

  @ApiBearerAuth()
  @Get('me/barbershops/:id/barbers')
  @ApiOperation({ summary: 'Barberos de una barbería que administro (incluye inactivos)' })
  @ApiOkResponse({ type: BarberManagePageDto })
  listManaged(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<BarberManagePageDto> {
    return this.barbers.listManaged(user.id, id, query);
  }

  @ApiBearerAuth()
  @Post('barbershops/:id/barbers')
  @ApiOperation({ summary: 'RF-BRB-001: registrar un barbero (perfil sin cuenta vinculada)' })
  @ApiCreatedResponse({ type: BarberManageDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CreateBarberDto,
    @Req() req: Request,
  ): Promise<BarberManageDto> {
    return this.barbers.create(user.id, id, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Post('barbershops/:id/barbers/me')
  @ApiOperation({ summary: 'RF-BRB-001: el responsable se registra como barbero (sin invitación)' })
  @ApiCreatedResponse({ type: BarberManageDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  linkSelf(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: LinkSelfAsBarberDto,
    @Req() req: Request,
  ): Promise<BarberManageDto> {
    return this.barbers.linkSelf(user.id, id, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Patch('barbershops/:id/barbers/:barberId')
  @ApiOperation({ summary: 'RF-BRB-002: actualizar un barbero (o desactivarlo)' })
  @ApiOkResponse({ type: BarberManageDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
    @Body() dto: UpdateBarberDto,
    @Req() req: Request,
  ): Promise<BarberManageDto> {
    return this.barbers.update(user.id, id, barberId, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Put('barbershops/:id/barbers/:barberId/services')
  @ApiOperation({ summary: 'RF-BRB-002: servicios que realiza el barbero' })
  @ApiOkResponse({ type: BarberManageDto })
  setServices(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
    @Body() dto: SetBarberServicesDto,
    @Req() req: Request,
  ): Promise<BarberManageDto> {
    return this.barbers.setServices(user.id, id, barberId, dto.serviceIds, req.ip ?? null);
  }
}
