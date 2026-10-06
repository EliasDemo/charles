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
  Query,
  Req,
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
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser, OptionalUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { PaginationQueryDto } from '../../common/pagination/pagination';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { BarbershopsService } from './barbershops.service';
import {
  BarbershopManageDto,
  BarbershopPublicDto,
  CreateBarbershopDto,
  CreatedBarbershopDto,
  CreatedIndependentDto,
  CreateIndependentDto,
  MyBarbershopPageDto,
  UpdateBarbershopDto,
  UpdateBarbershopStatusDto,
} from './dto/barbershop.dto';
import { ChangeMemberRoleDto, MemberPageDto } from './dto/member.dto';
import { MembersService } from './members.service';

const uuid = new ParseUUIDPipe();

@ApiTags('barbershops')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class BarbershopsController {
  constructor(
    private readonly barbershops: BarbershopsService,
    private readonly members: MembersService,
  ) {}

  @ApiBearerAuth()
  @Post('barbershops')
  @ApiOperation({
    summary: 'RF-BAR-001: registrar una barbería (quien la registra queda como OWNER)',
  })
  @ApiCreatedResponse({ type: CreatedBarbershopDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBarbershopDto,
    @Req() req: Request,
  ): Promise<CreatedBarbershopDto> {
    return this.barbershops.create(user.id, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Post('barbershops/independent')
  @ApiOperation({
    summary:
      'Barbero independiente: crea su negocio (INDEPENDENT), queda como OWNER y como su único barbero',
  })
  @ApiCreatedResponse({ type: CreatedIndependentDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createIndependent(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateIndependentDto,
    @Req() req: Request,
  ): Promise<CreatedIndependentDto> {
    return this.barbershops.createIndependent(user.id, dto, req.ip ?? null);
  }

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id')
  @ApiOperation({ summary: 'RF-BAR-002: información pública de una barbería' })
  @ApiOkResponse({ type: BarbershopPublicDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  findPublic(
    @Param('id', uuid) id: string,
    @OptionalUser() user: AuthUser | null,
  ): Promise<BarbershopPublicDto> {
    return this.barbershops.findPublic(id, user?.id ?? null);
  }

  @ApiBearerAuth()
  @Patch('barbershops/:id')
  @ApiOperation({ summary: 'RF-BAR-003: actualizar la información (OWNER o MANAGER)' })
  @ApiOkResponse({ type: BarbershopManageDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateBarbershopDto,
    @Req() req: Request,
  ): Promise<BarbershopManageDto> {
    return this.barbershops.update(user.id, id, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Patch('barbershops/:id/status')
  @ApiOperation({ summary: 'RF-BAR-004: atendiendo o cerrada temporalmente (solo OWNER)' })
  @ApiOkResponse({ type: BarbershopManageDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateBarbershopStatusDto,
    @Req() req: Request,
  ): Promise<BarbershopManageDto> {
    return this.barbershops.updateStatus(user.id, id, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Delete('barbershops/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar (borrado lógico; solo OWNER, sin reservas futuras)' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.barbershops.remove(user.id, id, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Get('me/barbershops')
  @ApiOperation({ summary: 'Barberías que administro' })
  @ApiOkResponse({ type: MyBarbershopPageDto })
  listMine(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationQueryDto,
  ): Promise<MyBarbershopPageDto> {
    return this.barbershops.listMine(user.id, query);
  }

  @ApiBearerAuth()
  @Get('me/barbershops/:id')
  @ApiOperation({ summary: 'Detalle de gestión de una barbería que administro' })
  @ApiOkResponse({ type: BarbershopManageDto })
  findManaged(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<BarbershopManageDto> {
    return this.barbershops.findManaged(user.id, id);
  }

  @ApiBearerAuth()
  @Get('barbershops/:id/members')
  @ApiOperation({ summary: 'Responsables de la barbería' })
  @ApiOkResponse({ type: MemberPageDto })
  listMembers(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<MemberPageDto> {
    return this.members.list(user.id, id, query);
  }

  @ApiBearerAuth()
  @Patch('barbershops/:id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cambiar el rol de un responsable (solo OWNER; nunca sin OWNER)' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  changeRole(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('userId', uuid) userId: string,
    @Body() dto: ChangeMemberRoleDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.members.changeRole(user.id, id, userId, dto.role, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Delete('barbershops/:id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitar un responsable o retirarse (nunca el último OWNER)' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('userId', uuid) userId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.members.remove(user.id, id, userId, req.ip ?? null);
  }
}
