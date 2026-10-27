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
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, OptionalUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { AdminAccessGuard, AdminOnly, CurrentStaff, type StaffActor } from '../admin/admin-access';
import { AdminAccessModule } from '../admin/admin-access.module';
import { ImageUploadDto } from '../images/dto/image.dto';
import { ImagesModule } from '../images/images.module';
import { ImagesService } from '../images/images.service';
import { SingleFile, UPLOAD_NOTE, UploadDocs, type UploadedImage } from '../images/upload';
import { VideoDto, VideoUploadDto } from '../videos/dto/video.dto';
import { VIDEO_UPLOAD_NOTE, VideoFile, VideosModule } from '../videos/videos.module';
import { VideosService } from '../videos/videos.service';
import {
  CampaignDto,
  CampaignMetricsDto,
  CreateCampaignDto,
  CreatePlacementDto,
  CreateProductDto,
  CreateSponsorDto,
  PlacementEventDto,
  PlacementsQueryDto,
  ProductClickDto,
  ProductDto,
  PublicPlacementDto,
  PublicSponsorDto,
  SponsorDto,
  SponsorMediaDto,
  StoreDto,
  StoreQueryDto,
  UpdateCampaignDto,
  UpdatePlacementDto,
  UpdateProductDto,
  UpdateSponsorDto,
} from './dto/sponsor.dto';
import { SponsorsService } from './sponsors.service';
import { StoreService } from './store.service';
import { SponsorPackagesService } from './sponsor-packages.service';
import {
  CreatePackagePurchaseDto,
  CreateSponsorPackageDto,
  PackagePurchaseDto,
  SponsorPackageDto,
  UpdateSponsorPackageDto,
} from './dto/sponsor-package.dto';

const uuid = new ParseUUIDPipe();

/** Fase 13: anuncios para la app (sin sesión o con ella). */
@ApiTags('sponsors')
@Public()
@RateLimit('public')
@Controller()
export class SponsorsController {
  constructor(
    private readonly sponsors: SponsorsService,
    private readonly storefront: StoreService,
  ) {}

  @Get('placements')
  @ApiOperation({
    summary: 'Anuncios vigentes de un espacio (hasta 3, mayor prioridad primero)',
    description:
      'home_banner, search_top y booking_success son de clientes; shop_dashboard, de la pantalla ' +
      'de la barbería. Lista vacía si no hay campañas.',
  })
  @ApiOkResponse({ type: [PublicPlacementDto] })
  placements(@Query() query: PlacementsQueryDto): Promise<PublicPlacementDto[]> {
    return this.sponsors.placementsFor(query.slot);
  }

  @Post('placements/:id/events')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Registrar una impresión o un clic',
    description:
      'Una por persona (o instalación) por hora y tipo; las repetidas se ignoran (204 igual). ' +
      'Sin sesión, envía viewerKey. No se guarda la IP.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async event(
    @OptionalUser() user: AuthUser | null,
    @Param('id', uuid) id: string,
    @Body() dto: PlacementEventDto,
  ): Promise<void> {
    await this.sponsors.recordEvent(id, dto.type, {
      userId: user?.id ?? null,
      viewerKey: dto.viewerKey,
    });
  }

  @Get('store')
  @ApiOperation({
    summary: 'Tienda: ofertas, productos, marcas por rubro, videos y descuentos',
    description:
      'Publicidad de marcas auspiciadoras (siempre etiquetada «Patrocinado»; nunca en la ' +
      'Comunidad). Charles no vende: cada producto enlaza a la tienda de la marca. Registra ' +
      'impresiones de `featured` como en /placements y los clics con /store/products/{id}/click.',
  })
  @ApiOkResponse({ type: StoreDto })
  store(@Query() query: StoreQueryDto): Promise<StoreDto> {
    return this.storefront.store(query);
  }

  @Post('store/products/:id/click')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Registrar un clic a "Ver en la tienda" de un producto',
    description: 'Uno por persona (o instalación) por hora; los repetidos se ignoran (204 igual).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async productClick(
    @OptionalUser() user: AuthUser | null,
    @Param('id', uuid) id: string,
    @Body() dto: ProductClickDto,
  ): Promise<void> {
    await this.storefront.productClick(id, { userId: user?.id ?? null, viewerKey: dto.viewerKey });
  }

  @Get('sponsors/:id')
  @ApiOperation({ summary: 'Marca auspiciadora: ficha, productos y videos (enlaces externos)' })
  @ApiOkResponse({ type: PublicSponsorDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  sponsor(@Param('id', uuid) id: string): Promise<PublicSponsorDto> {
    return this.sponsors.publicSponsor(id);
  }
}

/** Fase 13: auspiciadores, campañas, anuncios, productos y métricas (solo ADMIN). */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@AdminOnly()
@UseGuards(AdminAccessGuard)
@Controller('admin')
export class SponsorsAdminController {
  constructor(
    private readonly sponsors: SponsorsService,
    private readonly images: ImagesService,
    private readonly videos: VideosService,
  ) {}

  @Get('sponsors')
  @ApiOperation({ summary: 'Solo ADMIN: auspiciadores' })
  @ApiOkResponse({ type: [SponsorDto] })
  list(): Promise<SponsorDto[]> {
    return this.sponsors.listSponsors();
  }

  @Post('sponsors')
  @ApiOperation({ summary: 'Solo ADMIN: crear un auspiciador' })
  @ApiCreatedResponse({ type: SponsorDto })
  create(@CurrentStaff() staff: StaffActor, @Body() dto: CreateSponsorDto): Promise<SponsorDto> {
    return this.sponsors.createSponsor(staff.id, dto);
  }

  @Patch('sponsors/:id')
  @ApiOperation({ summary: 'Solo ADMIN: editar o desactivar un auspiciador' })
  @ApiOkResponse({ type: SponsorDto })
  update(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateSponsorDto,
  ): Promise<SponsorDto> {
    return this.sponsors.updateSponsor(staff.id, id, dto);
  }

  @Post('sponsors/media')
  @SingleFile()
  @UploadDocs(ImageUploadDto)
  @ApiOperation({
    summary: 'Solo ADMIN: subir una imagen de auspiciador (logo, anuncio o producto)',
    description: `${UPLOAD_NOTE} Devuelve las URL para usar en logoUrl o imageUrl.`,
  })
  @ApiCreatedResponse({ type: SponsorMediaDto })
  media(@UploadedFile() file: UploadedImage | undefined): Promise<SponsorMediaDto> {
    return this.images.uploadSponsorAsset(file?.buffer);
  }

  @Get('sponsors/:id/videos')
  @ApiOperation({ summary: 'Solo ADMIN: videos de la marca (también en proceso o fallidos)' })
  @ApiOkResponse({ type: [VideoDto] })
  sponsorVideos(@Param('id', uuid) id: string): Promise<VideoDto[]> {
    return this.videos.manageForSponsor(id);
  }

  @Post('sponsors/:id/videos')
  @VideoFile()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: VideoUploadDto })
  @ApiOperation({
    summary: 'Solo ADMIN: subir un video de la marca para la Tienda (máximo 5)',
    description: VIDEO_UPLOAD_NOTE,
  })
  @ApiAcceptedResponse({ type: VideoDto })
  @HttpCode(HttpStatus.ACCEPTED)
  uploadVideo(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @Body() dto: VideoUploadDto,
  ): Promise<VideoDto> {
    return this.videos.uploadForSponsor(staff.id, id, file?.buffer, dto.caption);
  }

  @Delete('sponsor-videos/:videoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Solo ADMIN: borrar un video de una marca' })
  @ApiNoContentResponse()
  async removeVideo(
    @CurrentStaff() staff: StaffActor,
    @Param('videoId', uuid) videoId: string,
  ): Promise<void> {
    await this.videos.removeForSponsor(staff.id, videoId);
  }

  @Get('sponsors/:id/campaigns')
  @ApiOperation({ summary: 'Solo ADMIN: campañas de un auspiciador, con sus anuncios' })
  @ApiOkResponse({ type: [CampaignDto] })
  campaigns(@Param('id', uuid) id: string): Promise<CampaignDto[]> {
    return this.sponsors.listCampaigns(id);
  }

  @Post('sponsors/:id/campaigns')
  @ApiOperation({ summary: 'Solo ADMIN: crear una campaña (en borrador)' })
  @ApiCreatedResponse({ type: CampaignDto })
  createCampaign(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: CreateCampaignDto,
  ): Promise<CampaignDto> {
    return this.sponsors.createCampaign(staff.id, id, dto);
  }

  @Patch('campaigns/:id')
  @ApiOperation({ summary: 'Solo ADMIN: editar, publicar, pausar o terminar una campaña' })
  @ApiOkResponse({ type: CampaignDto })
  updateCampaign(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateCampaignDto,
  ): Promise<CampaignDto> {
    return this.sponsors.updateCampaign(staff.id, id, dto);
  }

  @Get('campaigns/:id/metrics')
  @ApiOperation({ summary: 'Solo ADMIN: impresiones, clics y CTR de una campaña' })
  @ApiOkResponse({ type: CampaignMetricsDto })
  metrics(@Param('id', uuid) id: string): Promise<CampaignMetricsDto> {
    return this.sponsors.metrics(id);
  }

  @Post('campaigns/:id/placements')
  @ApiOperation({ summary: 'Solo ADMIN: agregar un anuncio a un espacio' })
  @ApiCreatedResponse({ type: CampaignDto })
  addPlacement(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: CreatePlacementDto,
  ): Promise<CampaignDto> {
    return this.sponsors.addPlacement(staff.id, id, dto);
  }

  @Patch('placements/:id')
  @ApiOperation({ summary: 'Solo ADMIN: editar un anuncio' })
  @ApiOkResponse({ type: CampaignDto })
  updatePlacement(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: UpdatePlacementDto,
  ): Promise<CampaignDto> {
    return this.sponsors.updatePlacement(staff.id, id, dto);
  }

  @Delete('placements/:id')
  @ApiOperation({ summary: 'Solo ADMIN: quitar un anuncio sin impresiones ni clics' })
  @ApiOkResponse({ type: CampaignDto })
  removePlacement(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
  ): Promise<CampaignDto> {
    return this.sponsors.removePlacement(staff.id, id);
  }

  @Get('sponsors/:id/products')
  @ApiOperation({ summary: 'Solo ADMIN: catálogo de productos del auspiciador' })
  @ApiOkResponse({ type: [ProductDto] })
  products(@Param('id', uuid) id: string): Promise<ProductDto[]> {
    return this.sponsors.listProducts(id);
  }

  @Post('sponsors/:id/products')
  @ApiOperation({ summary: 'Solo ADMIN: agregar un producto (con enlace externo de compra)' })
  @ApiCreatedResponse({ type: ProductDto })
  createProduct(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: CreateProductDto,
  ): Promise<ProductDto> {
    return this.sponsors.createProduct(staff.id, id, dto);
  }

  @Patch('products/:id')
  @ApiOperation({ summary: 'Solo ADMIN: editar u ocultar un producto' })
  @ApiOkResponse({ type: ProductDto })
  updateProduct(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<ProductDto> {
    return this.sponsors.updateProduct(staff.id, id, dto);
  }
}

/** Fase 15: paquetes para auspiciadores y su compra (solo ADMIN). */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@AdminOnly()
@UseGuards(AdminAccessGuard)
@Controller('admin')
export class SponsorPackagesAdminController {
  constructor(private readonly packages: SponsorPackagesService) {}

  @Get('sponsor-packages')
  @ApiOperation({ summary: 'Solo ADMIN: catálogo de paquetes para auspiciadores' })
  @ApiOkResponse({ type: [SponsorPackageDto] })
  list(): Promise<SponsorPackageDto[]> {
    return this.packages.list();
  }

  @Post('sponsor-packages')
  @ApiOperation({ summary: 'Solo ADMIN: crear un paquete' })
  @ApiCreatedResponse({ type: SponsorPackageDto })
  create(
    @CurrentStaff() staff: StaffActor,
    @Body() dto: CreateSponsorPackageDto,
  ): Promise<SponsorPackageDto> {
    return this.packages.create(staff.id, dto);
  }

  @Patch('sponsor-packages/:id')
  @ApiOperation({ summary: 'Solo ADMIN: editar o desactivar un paquete' })
  @ApiOkResponse({ type: SponsorPackageDto })
  update(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateSponsorPackageDto,
  ): Promise<SponsorPackageDto> {
    return this.packages.update(staff.id, id, dto);
  }

  @Get('sponsors/:id/package-purchases')
  @ApiOperation({ summary: 'Solo ADMIN: compras de paquetes de un auspiciador' })
  @ApiOkResponse({ type: [PackagePurchaseDto] })
  purchases(@Param('id', uuid) id: string): Promise<PackagePurchaseDto[]> {
    return this.packages.purchases(id);
  }

  @Post('sponsors/:id/package-purchases')
  @ApiOperation({
    summary: 'Solo ADMIN: vender un paquete (crea la campaña y envía el enlace de pago por correo)',
  })
  @ApiCreatedResponse({ type: PackagePurchaseDto })
  createPurchase(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: CreatePackagePurchaseDto,
  ): Promise<PackagePurchaseDto> {
    return this.packages.createPurchase(staff.id, id, dto);
  }

  @Post('package-purchases/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Solo ADMIN: anular una compra sin pagar' })
  @ApiOkResponse({ type: PackagePurchaseDto })
  cancelPurchase(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
  ): Promise<PackagePurchaseDto> {
    return this.packages.cancelPurchase(staff.id, id);
  }
}

@Module({
  imports: [AdminAccessModule, ImagesModule, VideosModule],
  controllers: [SponsorsController, SponsorsAdminController, SponsorPackagesAdminController],
  providers: [SponsorsService, SponsorPackagesService, StoreService],
})
export class SponsorsModule {}
