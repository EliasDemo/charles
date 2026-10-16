import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Job } from 'bullmq';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import {
  AdminAccessGuard,
  CurrentStaff,
  type StaffActor,
  SupportOrAdmin,
} from '../admin/admin-access';
import { AdminAccessModule } from '../admin/admin-access.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { ImageStorageModule } from '../images/image-storage.module';
import { ImageUploadRateLimitGuard } from '../images/image-rate-limit';
import { ImagesModule } from '../images/images.module';
import type { UploadedImage } from '../images/upload';
import { SettingsModule } from '../settings/settings.module';
import {
  ReportedVideoDto,
  VideoDto,
  VideoModerationDto,
  VideoReportDto,
  VideoUploadDto,
} from './dto/video.dto';
import { VIDEO_LIMITS } from './video-processing';
import { type VideoJob, VIDEOS_QUEUE, VideosService } from './videos.service';

const uuid = new ParseUUIDPipe();

/** Un archivo de video, en memoria, con el tope de 50 MB. */
const VideoFile = (): MethodDecorator & ClassDecorator =>
  UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: VIDEO_LIMITS.maxBytes, files: 1, fields: 5, parts: 7 },
    }),
  );

const UPLOAD_NOTE =
  'multipart/form-data, campo `file`: MP4, MOV o WebM de hasta 30 s y 50 MB. Responde enseguida ' +
  'con status PROCESSING; consulta la lista hasta que esté READY (o FAILED con failureReason). Se ' +
  'comprime a 720p y se eliminan los metadatos (GPS incluido).';

@ApiTags('videos')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/videos')
  @ApiOperation({ summary: 'Videos publicitarios de la barbería (listos y visibles)' })
  @ApiOkResponse({ type: [VideoDto] })
  shopVideos(@Param('id', uuid) id: string): Promise<VideoDto[]> {
    return this.videos.publicForBarbershop(id);
  }

  @Public()
  @RateLimit('public')
  @Get('barber-profiles/:id/videos')
  @ApiOperation({ summary: 'Videos de cortes del barbero (listos y visibles)' })
  @ApiOkResponse({ type: [VideoDto] })
  profileVideos(@Param('id', uuid) id: string): Promise<VideoDto[]> {
    return this.videos.publicForProfile(id);
  }

  @Get('barbershops/:id/videos/manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'OWNER o MANAGER: todos los videos (también en proceso o fallidos)' })
  @ApiOkResponse({ type: [VideoDto] })
  manageShop(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<VideoDto[]> {
    return this.videos.manageForBarbershop(user.id, id);
  }

  @Post('barbershops/:id/videos')
  @ApiBearerAuth()
  @UseGuards(ImageUploadRateLimitGuard)
  @VideoFile()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: VideoUploadDto })
  @ApiOperation({
    summary: 'OWNER o MANAGER: subir un video del local (máximo 5)',
    description: UPLOAD_NOTE,
  })
  @ApiAcceptedResponse({ type: VideoDto })
  @HttpCode(HttpStatus.ACCEPTED)
  uploadShop(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @Body() dto: VideoUploadDto,
  ): Promise<VideoDto> {
    return this.videos.uploadForBarbershop(user.id, id, file?.buffer, dto.caption);
  }

  @Get('me/barber-profile/videos')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mis videos de cortes (también en proceso o fallidos)' })
  @ApiOkResponse({ type: [VideoDto] })
  manageMine(@CurrentUser() user: AuthUser): Promise<VideoDto[]> {
    return this.videos.manageForProfile(user.id);
  }

  @Post('me/barber-profile/videos')
  @ApiBearerAuth()
  @UseGuards(ImageUploadRateLimitGuard)
  @VideoFile()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: VideoUploadDto })
  @ApiOperation({ summary: 'Subir un video de mis cortes (máximo 10)', description: UPLOAD_NOTE })
  @ApiAcceptedResponse({ type: VideoDto })
  @HttpCode(HttpStatus.ACCEPTED)
  uploadMine(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedImage | undefined,
    @Body() dto: VideoUploadDto,
  ): Promise<VideoDto> {
    return this.videos.uploadForProfile(user.id, file?.buffer, dto.caption);
  }

  @Delete('videos/:id')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un video (su barbería o su barbero)' })
  @ApiNoContentResponse()
  async remove(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<void> {
    await this.videos.remove(user.id, id);
  }

  @Post('videos/:id/report')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reportar un video (una vez por persona)' })
  @ApiNoContentResponse()
  async report(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: VideoReportDto,
  ): Promise<void> {
    await this.videos.report(user.id, id, dto);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@SupportOrAdmin()
@UseGuards(AdminAccessGuard)
@Controller('admin/videos')
export class VideosAdminController {
  constructor(private readonly videos: VideosService) {}

  @Get('reported')
  @ApiOperation({ summary: 'Videos con reportes abiertos' })
  @ApiOkResponse({ type: [ReportedVideoDto] })
  reported(): Promise<ReportedVideoDto[]> {
    return this.videos.reported();
  }

  @Post(':id/moderation')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mantener, retirar o restaurar un video (con motivo)' })
  @ApiNoContentResponse()
  async moderate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: VideoModerationDto,
  ): Promise<void> {
    await this.videos.moderate(staff.id, id, dto);
  }
}

// En las pruebas el procesamiento se llama directamente (`VideosService.process`): el worker no
// arranca, para que no compita con la prueba ni retrase el cierre de la app.
@Processor(VIDEOS_QUEUE, { concurrency: 1, autorun: process.env.NODE_ENV !== 'test' })
export class VideosProcessor extends WorkerHost {
  constructor(private readonly videos: VideosService) {
    super();
  }

  async process(job: Job<VideoJob>): Promise<void> {
    await this.videos.process(job.data.videoId);
  }
}

@Module({
  imports: [
    BarbershopAccessModule,
    AdminAccessModule,
    ImageStorageModule,
    ImagesModule,
    SettingsModule,
    BullModule.registerQueue({ name: VIDEOS_QUEUE }),
  ],
  controllers: [VideosController, VideosAdminController],
  providers: [VideosService, VideosProcessor],
})
export class VideosModule {}
