import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { AnswerJobOfferDto, CreateJobOfferDto, JobOfferDto } from './dto/jobs.dto';
import { JobOffersService } from './job-offers.service';

const uuid = new ParseUUIDPipe();

/** Ofertas directas: la barbería ofrece trabajo a un barbero concreto; él acepta o rechaza. */
@ApiTags('jobs')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class JobOffersController {
  constructor(private readonly offers: JobOffersService) {}

  @Post('barbershops/:barbershopId/job-offers')
  @ApiOperation({
    summary: 'OWNER o MANAGER: ofrecer trabajo directamente a un barbero (por su perfil)',
  })
  @ApiCreatedResponse({ type: JobOfferDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Ya trabaja aquí o ya tiene una oferta pendiente.',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Body() dto: CreateJobOfferDto,
  ): Promise<JobOfferDto> {
    return this.offers.create(user.id, barbershopId, dto);
  }

  @Get('barbershops/:barbershopId/job-offers')
  @ApiOperation({ summary: 'OWNER o MANAGER: ofertas directas enviadas (100 más recientes)' })
  @ApiOkResponse({ type: [JobOfferDto] })
  list(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
  ): Promise<JobOfferDto[]> {
    return this.offers.listForShop(user.id, barbershopId);
  }

  @Post('barbershops/:barbershopId/job-offers/:offerId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'OWNER o MANAGER: retirar una oferta pendiente' })
  @ApiOkResponse({ type: JobOfferDto })
  withdraw(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Param('offerId', uuid) offerId: string,
  ): Promise<JobOfferDto> {
    return this.offers.withdraw(user.id, barbershopId, offerId);
  }

  @Get('me/job-offers')
  @ApiOperation({ summary: 'Barbero: ofertas de trabajo que recibí' })
  @ApiOkResponse({ type: [JobOfferDto] })
  mine(@CurrentUser() user: AuthUser): Promise<JobOfferDto[]> {
    return this.offers.mine(user.id);
  }

  @Post('me/job-offers/:offerId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Barbero: aceptar (entro al equipo de la barbería)' })
  @ApiOkResponse({ type: JobOfferDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('offerId', uuid) offerId: string,
    @Body() dto: AnswerJobOfferDto,
  ): Promise<JobOfferDto> {
    return this.offers.answer(user.id, offerId, true, dto.note);
  }

  @Post('me/job-offers/:offerId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Barbero: rechazar' })
  @ApiOkResponse({ type: JobOfferDto })
  reject(
    @CurrentUser() user: AuthUser,
    @Param('offerId', uuid) offerId: string,
    @Body() dto: AnswerJobOfferDto,
  ): Promise<JobOfferDto> {
    return this.offers.answer(user.id, offerId, false, dto.note);
  }
}
