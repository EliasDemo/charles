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
  ApiCreatedResponse,
  ApiNoContentResponse,
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
import {
  CreateServiceDto,
  ServiceManageDto,
  ServiceManagePageDto,
  ServicePublicPageDto,
  UpdateServiceDto,
} from './dto/service.dto';
import { ServicesService } from './services.service';

const uuid = new ParseUUIDPipe();

@ApiTags('services')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/services')
  @ApiOperation({ summary: 'RF-SER-003: servicios disponibles con precio y duración' })
  @ApiOkResponse({ type: ServicePublicPageDto })
  listPublic(
    @Param('id', uuid) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<ServicePublicPageDto> {
    return this.services.listPublic(id, query);
  }

  @ApiBearerAuth()
  @Get('me/barbershops/:id/services')
  @ApiOperation({ summary: 'Servicios de una barbería que administro (incluye no disponibles)' })
  @ApiOkResponse({ type: ServiceManagePageDto })
  listManaged(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<ServiceManagePageDto> {
    return this.services.listManaged(user.id, id, query);
  }

  @ApiBearerAuth()
  @Post('barbershops/:id/services')
  @ApiOperation({
    summary: 'RF-SER-001: registrar un servicio (precio > 0, 5–480 min en múltiplos de 5)',
  })
  @ApiCreatedResponse({ type: ServiceManageDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CreateServiceDto,
    @Req() req: Request,
  ): Promise<ServiceManageDto> {
    return this.services.create(user.id, id, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Patch('barbershops/:id/services/:serviceId')
  @ApiOperation({ summary: 'RF-SER-002: actualizar un servicio' })
  @ApiOkResponse({ type: ServiceManageDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('serviceId', uuid) serviceId: string,
    @Body() dto: UpdateServiceDto,
    @Req() req: Request,
  ): Promise<ServiceManageDto> {
    return this.services.update(user.id, id, serviceId, dto, req.ip ?? null);
  }

  @ApiBearerAuth()
  @Delete('barbershops/:id/services/:serviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un servicio (borrado lógico)' })
  @ApiNoContentResponse()
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('serviceId', uuid) serviceId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.services.remove(user.id, id, serviceId, req.ip ?? null);
  }
}
