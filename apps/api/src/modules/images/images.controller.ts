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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import {
  BarberPhotoDto,
  BarbershopMediaDto,
  CreateImageReportDto,
  GalleryImageManageDto,
  GalleryManagePageDto,
  GalleryPageDto,
  GalleryQueryDto,
  GalleryUploadDto,
  ImageUploadDto,
  ServiceStyleDto,
  SetSpecialtiesDto,
  StylesQueryDto,
  UpdateGalleryImageDto,
} from './dto/image.dto';
import { MAX_UPLOAD_BYTES } from './image-processing';
import { ImageUploadRateLimitGuard } from './image-rate-limit';
import { ImagesService } from './images.service';

const uuid = new ParseUUIDPipe();

/** Lo único que se usa del archivo que entrega multer: el contenido en memoria. */
interface UploadedImage {
  buffer: Buffer;
}

/** Un solo archivo, en memoria (sin `dest` multer nunca escribe a disco), con el tope de la API. */
const SingleFile = (): MethodDecorator =>
  UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 12 },
    }),
  );

/** Documentación común de las subidas. */
const UploadDocs = (body: new () => unknown): MethodDecorator => {
  return (target, key, descriptor) => {
    ApiConsumes('multipart/form-data')(target, key, descriptor);
    ApiBody({ type: body })(target, key, descriptor);
    ApiBadRequestResponse({ type: ErrorResponseDto })(target, key, descriptor);
    ApiPayloadTooLargeResponse({ type: ErrorResponseDto })(target, key, descriptor);
    ApiTooManyRequestsResponse({ type: ErrorResponseDto })(target, key, descriptor);
    ApiServiceUnavailableResponse({ type: ErrorResponseDto })(target, key, descriptor);
  };
};

const UPLOAD_NOTE =
  'multipart/form-data, campo `file`: JPEG, PNG o WebP hasta 10 MB (HEIC: convertir en la app). ' +
  'Se eliminan los metadatos (EXIF y GPS) y se guarda en WebP.';

@ApiTags('images')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  // ───────────── Logo y portada (OWNER o MANAGER) ─────────────

  @Put('barbershops/:id/logo')
  @ApiBearerAuth()
  @UseGuards(ImageUploadRateLimitGuard)
  @SingleFile()
  @UploadDocs(ImageUploadDto)
  @ApiOperation({
    summary: 'Fase 14: subir o reemplazar el logo (cuadrado de 512 px)',
    description: UPLOAD_NOTE,
  })
  @ApiOkResponse({ type: BarbershopMediaDto })
  setLogo(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @Req() req: Request,
  ): Promise<BarbershopMediaDto> {
    return this.images.setBarbershopImage(
      user.id,
      id,
      'BARBERSHOP_LOGO',
      file?.buffer,
      req.ip ?? null,
    );
  }

  @Delete('barbershops/:id/logo')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fase 14: quitar el logo' })
  @ApiOkResponse({ type: BarbershopMediaDto })
  deleteLogo(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<BarbershopMediaDto> {
    return this.images.deleteBarbershopImage(user.id, id, 'BARBERSHOP_LOGO', req.ip ?? null);
  }

  @Put('barbershops/:id/cover')
  @ApiBearerAuth()
  @UseGuards(ImageUploadRateLimitGuard)
  @SingleFile()
  @UploadDocs(ImageUploadDto)
  @ApiOperation({
    summary: 'Fase 14: subir o reemplazar la portada (foto del local; 400 y 1600 px)',
    description: `${UPLOAD_NOTE} Cumple el requisito PHOTO del envío a revisión.`,
  })
  @ApiOkResponse({ type: BarbershopMediaDto })
  setCover(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @Req() req: Request,
  ): Promise<BarbershopMediaDto> {
    return this.images.setBarbershopImage(
      user.id,
      id,
      'BARBERSHOP_COVER',
      file?.buffer,
      req.ip ?? null,
    );
  }

  @Delete('barbershops/:id/cover')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fase 14: quitar la portada' })
  @ApiOkResponse({ type: BarbershopMediaDto })
  deleteCover(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<BarbershopMediaDto> {
    return this.images.deleteBarbershopImage(user.id, id, 'BARBERSHOP_COVER', req.ip ?? null);
  }

  // ───────────── Barbero: foto, galería y especialidades (OWNER, MANAGER o el propio barbero) ─────────────

  @Put('barbershops/:id/barbers/:barberId/photo')
  @ApiBearerAuth()
  @UseGuards(ImageUploadRateLimitGuard)
  @SingleFile()
  @UploadDocs(ImageUploadDto)
  @ApiOperation({
    summary: 'Fase 14: subir o reemplazar la foto del barbero (512 px)',
    description: UPLOAD_NOTE,
  })
  @ApiOkResponse({ type: BarberPhotoDto })
  setBarberPhoto(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
    @UploadedFile() file: UploadedImage | undefined,
    @Req() req: Request,
  ): Promise<BarberPhotoDto> {
    return this.images.setBarberPhoto(user.id, id, barberId, file?.buffer, req.ip ?? null);
  }

  @Delete('barbershops/:id/barbers/:barberId/photo')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fase 14: quitar la foto del barbero' })
  @ApiOkResponse({ type: BarberPhotoDto })
  deleteBarberPhoto(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
    @Req() req: Request,
  ): Promise<BarberPhotoDto> {
    return this.images.deleteBarberPhoto(user.id, id, barberId, req.ip ?? null);
  }

  @Post('barbershops/:id/barbers/:barberId/gallery')
  @ApiBearerAuth()
  @UseGuards(ImageUploadRateLimitGuard)
  @SingleFile()
  @UploadDocs(GalleryUploadDto)
  @ApiOperation({
    summary: 'Fase 14: subir una foto a la galería del barbero',
    description:
      `${UPLOAD_NOTE} Exige consent=true (consentimiento de la persona fotografiada). ` +
      'Máximo images.gallery_max_per_barber (60) por barbero.',
  })
  @ApiCreatedResponse({ type: GalleryImageManageDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  uploadGallery(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
    @UploadedFile() file: UploadedImage | undefined,
    @Body() dto: GalleryUploadDto,
    @Req() req: Request,
  ): Promise<GalleryImageManageDto> {
    return this.images.uploadGallery(user.id, id, barberId, file?.buffer, dto, req.ip ?? null);
  }

  @Patch('barbershops/:id/gallery/:imageId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fase 14: editar una foto (texto, estilos, servicio, destacar)' })
  @ApiOkResponse({ type: GalleryImageManageDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  updateGallery(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('imageId', uuid) imageId: string,
    @Body() dto: UpdateGalleryImageDto,
    @Req() req: Request,
  ): Promise<GalleryImageManageDto> {
    return this.images.updateGallery(user.id, id, imageId, dto, req.ip ?? null);
  }

  @Delete('barbershops/:id/gallery/:imageId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Fase 14: borrar una foto de la galería (también el archivo)' })
  @ApiNoContentResponse()
  deleteGallery(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('imageId', uuid) imageId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.images.deleteGallery(user.id, id, imageId, req.ip ?? null);
  }

  @Get('me/barbershops/:id/gallery')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Fase 14: galería de gestión (incluye ocultas y reportes abiertos)',
    description: 'OWNER y MANAGER ven todas; el barbero, solo la suya.',
  })
  @ApiOkResponse({ type: GalleryManagePageDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  manageGallery(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: GalleryQueryDto,
  ): Promise<GalleryManagePageDto> {
    return this.images.manageGallery(user.id, id, query);
  }

  @Put('barbershops/:id/barbers/:barberId/specialties')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Fase 14: especialidades del barbero (hasta 5 estilos)' })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  setSpecialties(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
    @Body() dto: SetSpecialtiesDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.images.setSpecialties(user.id, id, barberId, dto, req.ip ?? null);
  }

  // ───────────── Público ─────────────

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/gallery')
  @ApiOperation({
    summary: 'Fase 14: galería pública de la barbería (filtros: barbero y estilo)',
    description:
      'Destacadas aparte en la primera página. Sin fotos retiradas ni ocultas por reportes. ' +
      'Cada foto trae, si aplica, el servicio para "reservar este estilo".',
  })
  @ApiOkResponse({ type: GalleryPageDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  publicGallery(
    @Param('id', uuid) id: string,
    @Query() query: GalleryQueryDto,
  ): Promise<GalleryPageDto> {
    return this.images.publicGallery(id, query);
  }

  @Public()
  @RateLimit('public')
  @Get('service-styles')
  @ApiOperation({
    summary: 'Fase 14: estilos activos (para etiquetar fotos y filtrar la búsqueda)',
  })
  @ApiOkResponse({ type: [ServiceStyleDto] })
  listStyles(@Query() query: StylesQueryDto): Promise<ServiceStyleDto[]> {
    return this.images.listStyles(query.category);
  }

  @Post('gallery/:imageId/reports')
  @ApiBearerAuth()
  @UseGuards(ImageUploadRateLimitGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Fase 14: reportar una foto (no es mía, sin consentimiento, inapropiada…)',
    description:
      'Una vez por persona y foto. Con images.report_hide_threshold (3) reportes abiertos se oculta ' +
      'hasta que soporte la revise.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  report(
    @CurrentUser() user: AuthUser,
    @Param('imageId', uuid) imageId: string,
    @Body() dto: CreateImageReportDto,
  ): Promise<void> {
    return this.images.report(user.id, imageId, dto);
  }
}
