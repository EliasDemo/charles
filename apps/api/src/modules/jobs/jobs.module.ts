import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser, OptionalUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { BarbersModule } from '../barbers/barbers.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { ImageStorageModule } from '../images/image-storage.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { MessagingModule } from '../messaging/messaging.module';
import { UsersModule } from '../users/users.module';
import {
  ApplyDto,
  CreateJobPostingDto,
  DecideApplicationDto,
  InviteProfileDto,
  JobApplicationDto,
  JobPostingDto,
  JobPostingPageDto,
  JobsQueryDto,
  UpdateJobPostingDto,
} from './dto/jobs.dto';
import { JobsService } from './jobs.service';
import { JobOffersController } from './job-offers.controller';
import { JobOffersService } from './job-offers.service';

const uuid = new ParseUUIDPipe();

class InvitedBarberDto {
  @ApiProperty({ format: 'uuid', description: 'Vínculo creado (pendiente de que acepte).' })
  barberId!: string;
}

/** Bolsa de trabajo: ofertas abiertas (sin sesión) y postulaciones de barberos. */
@ApiTags('jobs')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Public()
  @RateLimit('public')
  @Get('jobs')
  @ApiOperation({
    summary: 'Ofertas de trabajo abiertas (más recientes primero)',
    description: 'Con sesión de barbero, cada oferta dice si ya postulé (myApplicationStatus).',
  })
  @ApiOkResponse({ type: JobPostingPageDto })
  list(
    @OptionalUser() user: AuthUser | null,
    @Query() query: JobsQueryDto,
  ): Promise<JobPostingPageDto> {
    return this.jobs.list(query, user?.id ?? null);
  }

  @Public()
  @RateLimit('public')
  @Get('jobs/:id')
  @ApiOperation({ summary: 'Detalle de una oferta' })
  @ApiOkResponse({ type: JobPostingDto })
  get(
    @OptionalUser() user: AuthUser | null,
    @Param('id', uuid) id: string,
  ): Promise<JobPostingDto> {
    return this.jobs.get(id, user?.id ?? null);
  }

  @Post('jobs/:id/applications')
  @ApiBearerAuth()
  @RateLimit('messages')
  @ApiOperation({
    summary: 'Postular (barbero con perfil profesional)',
    description:
      'La barbería ve mi perfil, ranking y portafolio, y recibe un mensaje en su bandeja.',
  })
  @ApiCreatedResponse({ type: JobApplicationDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'ALREADY_APPLIED, JOB_POSTING_CLOSED',
  })
  apply(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: ApplyDto,
  ): Promise<JobApplicationDto> {
    return this.jobs.apply(user.id, id, dto.message);
  }

  @Get('me/job-applications')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mis postulaciones' })
  @ApiOkResponse({ type: [JobApplicationDto] })
  mine(@CurrentUser() user: AuthUser): Promise<JobApplicationDto[]> {
    return this.jobs.mine(user.id);
  }

  @Post('me/job-applications/:id/withdraw')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retirar mi postulación (mientras no esté decidida)' })
  @ApiOkResponse({ type: JobApplicationDto })
  withdraw(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<JobApplicationDto> {
    return this.jobs.withdraw(user.id, id);
  }
}

/** Ofertas y postulaciones de la barbería (OWNER o MANAGER). */
@ApiTags('jobs')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('barbershops/:barbershopId')
export class BarbershopJobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get('jobs')
  @ApiOperation({ summary: 'OWNER o MANAGER: mis ofertas (abiertas y cerradas)' })
  @ApiOkResponse({ type: [JobPostingDto] })
  list(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
  ): Promise<JobPostingDto[]> {
    return this.jobs.listForShop(user.id, barbershopId);
  }

  @Post('jobs')
  @ApiOperation({ summary: 'OWNER o MANAGER: publicar una oferta (máximo 10 abiertas)' })
  @ApiCreatedResponse({ type: JobPostingDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Body() dto: CreateJobPostingDto,
  ): Promise<JobPostingDto> {
    return this.jobs.create(user.id, barbershopId, dto);
  }

  @Patch('jobs/:id')
  @ApiOperation({ summary: 'OWNER o MANAGER: editar, cerrar o reabrir una oferta' })
  @ApiOkResponse({ type: JobPostingDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateJobPostingDto,
  ): Promise<JobPostingDto> {
    return this.jobs.update(user.id, barbershopId, id, dto);
  }

  @Get('jobs/:id/applications')
  @ApiOperation({ summary: 'OWNER o MANAGER: postulaciones de una oferta' })
  @ApiOkResponse({ type: [JobApplicationDto] })
  applications(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Param('id', uuid) id: string,
  ): Promise<JobApplicationDto[]> {
    return this.jobs.applications(user.id, barbershopId, id);
  }

  @Post('job-applications/:id/decision')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'OWNER o MANAGER: preseleccionar, rechazar o contratar',
    description: 'HIRED crea el vínculo del barbero (asígnale servicios y horario después).',
  })
  @ApiOkResponse({ type: JobApplicationDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  decide(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Param('id', uuid) id: string,
    @Body() dto: DecideApplicationDto,
  ): Promise<JobApplicationDto> {
    return this.jobs.decide(user.id, barbershopId, id, dto.status);
  }

  @Post('barber-invitations')
  @RateLimit('messages')
  @ApiOperation({
    summary: 'OWNER o MANAGER: invitar a un barbero desde su perfil profesional',
    description: 'Le llega la invitación por correo (código) y un mensaje a su bandeja.',
  })
  @ApiCreatedResponse({ type: InvitedBarberDto })
  invite(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
    @Body() dto: InviteProfileDto,
  ): Promise<InvitedBarberDto> {
    return this.jobs.inviteProfile(user, barbershopId, dto.barberProfileId, dto.message);
  }
}

@Module({
  imports: [
    BarbershopAccessModule,
    BarbersModule,
    UsersModule,
    InvitationsModule,
    MessagingModule,
    ImageStorageModule,
  ],
  controllers: [JobsController, BarbershopJobsController, JobOffersController],
  providers: [JobsService, JobOffersService],
})
export class JobsModule {}
