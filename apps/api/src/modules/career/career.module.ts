import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
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
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { BarbersModule } from '../barbers/barbers.module';
import { BookingsModule } from '../bookings/bookings.module';
import { ImageUploadDto } from '../images/dto/image.dto';
import { ImageStorageModule } from '../images/image-storage.module';
import { ImageUploadRateLimitGuard } from '../images/image-rate-limit';
import { ImagesModule } from '../images/images.module';
import { ImagesService } from '../images/images.service';
import { SingleFile, UPLOAD_NOTE, UploadDocs, type UploadedImage } from '../images/upload';
import { ProfilePhotoDto } from '../users/dto/profile.dto';
import { BarberProfilesService } from './barber-profiles.service';
import {
  BarberProfileDto,
  PortfolioItemDto,
  PortfolioPageDto,
  PortfolioQueryDto,
  PortfolioUploadDto,
  ProfileReviewPageDto,
  RankingPageDto,
  RankingQueryDto,
  SetProfileSpecialtiesDto,
  UpsertBarberProfileDto,
} from './dto/career.dto';

const uuid = new ParseUUIDPipe();

/** Carrera del barbero: su propio perfil profesional (el barbero autenticado). */
@ApiTags('career')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('me/barber-profile')
export class MyBarberProfileController {
  constructor(
    private readonly profiles: BarberProfilesService,
    private readonly images: ImagesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Mi perfil profesional (404 si aún no lo creo)',
    description:
      'Incluye dónde trabajo y dónde trabajé (workplaces), mis especialidades y mi puesto.',
  })
  @ApiOkResponse({ type: BarberProfileDto })
  mine(@CurrentUser() user: AuthUser): Promise<BarberProfileDto> {
    return this.profiles.mine(user.id);
  }

  @Put()
  @ApiOperation({
    summary: 'Crear o editar mi perfil profesional',
    description:
      'Es mío, no de la barbería: me llevo mis valoraciones, mi portafolio y mi ranking si me voy. ' +
      'Crearlo da el rol BARBER (renueva la sesión para verlo en el token).',
  })
  @ApiOkResponse({ type: BarberProfileDto })
  upsert(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertBarberProfileDto,
    @Req() req: Request,
  ): Promise<BarberProfileDto> {
    return this.profiles.upsertMine(user.id, dto, req.ip ?? null);
  }

  @Put('specialties')
  @ApiOperation({ summary: 'Mis especialidades (máximo 10 estilos)' })
  @ApiOkResponse({ type: BarberProfileDto })
  specialties(
    @CurrentUser() user: AuthUser,
    @Body() dto: SetProfileSpecialtiesDto,
  ): Promise<BarberProfileDto> {
    return this.profiles.setSpecialties(user.id, dto.styleIds);
  }

  @Put('photo')
  @UseGuards(ImageUploadRateLimitGuard)
  @SingleFile()
  @UploadDocs(ImageUploadDto)
  @ApiOperation({ summary: 'Foto de mi perfil profesional (512 px)', description: UPLOAD_NOTE })
  @ApiOkResponse({ type: ProfilePhotoDto })
  setPhoto(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedImage | undefined,
    @Req() req: Request,
  ): Promise<ProfilePhotoDto> {
    return this.images.setProfilePhoto(user.id, file?.buffer, req.ip ?? null);
  }

  @Delete('photo')
  @ApiOperation({ summary: 'Quitar la foto de mi perfil profesional' })
  @ApiOkResponse({ type: ProfilePhotoDto })
  deletePhoto(@CurrentUser() user: AuthUser, @Req() req: Request): Promise<ProfilePhotoDto> {
    return this.images.deleteProfilePhoto(user.id, req.ip ?? null);
  }

  @Post('portfolio')
  @UseGuards(ImageUploadRateLimitGuard)
  @SingleFile()
  @UploadDocs(PortfolioUploadDto)
  @ApiOperation({
    summary: 'Subir un corte a mi portafolio',
    description: `${UPLOAD_NOTE} Exige consent=true (la persona fotografiada aceptó). Mismo tope que la galería.`,
  })
  @ApiCreatedResponse({ type: PortfolioItemDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'IMAGE_LIMIT_REACHED' })
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedImage | undefined,
    @Body() dto: PortfolioUploadDto,
    @Req() req: Request,
  ): Promise<PortfolioItemDto> {
    return this.images.uploadPortfolio(user.id, file?.buffer, dto, req.ip ?? null);
  }

  @Delete('portfolio/:imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Quitar un corte de mi portafolio (también los subidos en una barbería)',
  })
  @ApiNoContentResponse()
  async removePortfolio(
    @CurrentUser() user: AuthUser,
    @Param('imageId', uuid) imageId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.images.deletePortfolio(user.id, imageId, req.ip ?? null);
  }

  @Post('workplaces/:barberId/leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dejar una barbería',
    description:
      'Termina el vínculo. Mis valoraciones, portafolio y ranking siguen conmigo. Con reservas ' +
      'futuras activas: 409 HAS_FUTURE_BOOKINGS. Mi barbería independiente no se deja así (409).',
  })
  @ApiOkResponse({ type: BarberProfileDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  leave(
    @CurrentUser() user: AuthUser,
    @Param('barberId', uuid) barberId: string,
    @Req() req: Request,
  ): Promise<BarberProfileDto> {
    return this.profiles.leave(user.id, barberId, req.ip ?? null);
  }
}

/** Carrera del barbero: perfiles públicos y ranking (sin sesión). */
@ApiTags('career')
@Public()
@RateLimit('public')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class BarberProfilesController {
  constructor(
    private readonly profiles: BarberProfilesService,
    private readonly images: ImagesService,
  ) {}

  @Get('barbers/ranking')
  @ApiOperation({
    summary: 'Ranking y búsqueda de barberos',
    description:
      'Promedio bayesiano (pocas valoraciones no pesan como muchas); entra al ranking con 3 ' +
      'valoraciones. Filtros: especialidad, distrito, nombre y "disponible para trabajar".',
  })
  @ApiOkResponse({ type: RankingPageDto })
  ranking(@Query() query: RankingQueryDto): Promise<RankingPageDto> {
    return this.profiles.ranking(query);
  }

  @Get('barber-profiles/:id')
  @ApiOperation({
    summary: 'Perfil público de un barbero (dónde trabaja hoy, especialidades, ranking)',
  })
  @ApiOkResponse({ type: BarberProfileDto })
  profile(@Param('id', uuid) id: string): Promise<BarberProfileDto> {
    return this.profiles.publicProfile(id);
  }

  @Get('barber-profiles/:id/portfolio')
  @ApiOperation({ summary: 'Portafolio del barbero: sus cortes en todas sus barberías' })
  @ApiOkResponse({ type: PortfolioPageDto })
  async portfolio(
    @Param('id', uuid) id: string,
    @Query() query: PortfolioQueryDto,
  ): Promise<PortfolioPageDto> {
    await this.profiles.publicProfile(id);
    return this.images.portfolio(id, query);
  }

  @Get('barber-profiles/:id/reviews')
  @ApiOperation({ summary: 'Valoraciones de toda su carrera (más recientes primero)' })
  @ApiOkResponse({ type: ProfileReviewPageDto })
  reviews(
    @Param('id', uuid) id: string,
    @Query() query: PortfolioQueryDto,
  ): Promise<ProfileReviewPageDto> {
    return this.profiles.reviews(id, query);
  }
}

@Module({
  imports: [BarbersModule, BookingsModule, ImagesModule, ImageStorageModule],
  controllers: [MyBarberProfileController, BarberProfilesController],
  providers: [BarberProfilesService],
  exports: [BarberProfilesService],
})
export class CareerModule {}
