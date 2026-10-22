import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Job, Queue } from 'bullmq';
import type { Request, Response } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { ImageStorageModule } from '../images/image-storage.module';
import { ServicesModule } from '../services/services.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { CatalogService } from './catalog.service';
import {
  BarberCommissionDto,
  CashSessionDto,
  CatalogItemDto,
  CatalogSourceDto,
  CloseCashDto,
  CreateSaleDto,
  CreateShopClientDto,
  ImportCatalogItemDto,
  InvoicingConfigDto,
  OpenCashDto,
  RankingDto,
  ReportsQueryDto,
  SaleDto,
  SalesQueryDto,
  SalesReportDto,
  ShopClientDetailDto,
  ShopClientDto,
  ShopClientsQueryDto,
  UpdateCatalogItemDto,
  UpdateInvoicingConfigDto,
  UpdateShopClientDto,
  VoidSaleDto,
} from './dto/shop.dto';
import { FakeInvoiceProvider, NubefactInvoiceProvider } from './invoice-provider';
import { ReportsService } from './reports.service';
import { SalesService } from './sales.service';
import { ShopClientsService } from './shop-clients.service';

const uuid = new ParseUUIDPipe();
type Actor = { userId: string; ip?: string | null };
const actorOf = (user: AuthUser, req: Request): Actor => ({ userId: user.id, ip: req.ip });

/**
 * Panel de gestión de la barbería (OWNER y MANAGER): clientes y ranking, catálogo de cortes,
 * caja, ventas en el local con boleta y reportes. Los límites y funciones dependen del plan.
 */
@ApiTags('shop')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({
  type: ErrorResponseDto,
  description: 'PLAN_LIMIT_REACHED o PLAN_FEATURE_NOT_INCLUDED',
})
@Controller('barbershops/:id')
export class ShopController {
  constructor(
    private readonly clients: ShopClientsService,
    private readonly catalog: CatalogService,
    private readonly sales: SalesService,
    private readonly reports: ReportsService,
  ) {}

  // ── Clientes ──

  @Get('clients')
  @ApiOperation({ summary: 'Clientes de la barbería (búsqueda, nivel, habituales)' })
  @ApiOkResponse({ type: [ShopClientDto] })
  listClients(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: ShopClientsQueryDto,
  ): Promise<ShopClientDto[]> {
    return this.clients.list(user.id, id, query);
  }

  @Post('clients')
  @ApiOperation({ summary: 'Registrar un cliente (del local o con su usuario de la app)' })
  @ApiCreatedResponse({ type: ShopClientDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createClient(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CreateShopClientDto,
    @Req() req: Request,
  ): Promise<ShopClientDto> {
    return this.clients.create(actorOf(user, req), id, dto);
  }

  @Get('clients/ranking')
  @ApiOperation({ summary: 'Ranking de clientes: niveles y los 50 mejores (plan con ranking)' })
  @ApiOkResponse({ type: RankingDto })
  ranking(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<RankingDto> {
    return this.clients.ranking(user.id, id);
  }

  @Post('clients/ranking/recompute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recalcular el ranking ahora (se recalcula solo cada noche)' })
  @ApiOkResponse({ type: RankingDto })
  recompute(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<RankingDto> {
    return this.clients.recomputeFor(user.id, id);
  }

  @Get('clients/:clientId')
  @ApiOperation({ summary: 'Cliente con su historial (reservas atendidas y ventas)' })
  @ApiOkResponse({ type: ShopClientDetailDto })
  client(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('clientId', uuid) clientId: string,
  ): Promise<ShopClientDetailDto> {
    return this.clients.detail(user.id, id, clientId);
  }

  @Patch('clients/:clientId')
  @ApiOperation({ summary: 'Editar un cliente (notas, preferencias, habitual, archivar)' })
  @ApiOkResponse({ type: ShopClientDto })
  updateClient(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('clientId', uuid) clientId: string,
    @Body() dto: UpdateShopClientDto,
    @Req() req: Request,
  ): Promise<ShopClientDto> {
    return this.clients.update(actorOf(user, req), id, clientId, dto);
  }

  // ── Catálogo de cortes ──

  @Get('catalog')
  @ApiOperation({ summary: 'Catálogo de cortes (servicios con estilo y foto)' })
  @ApiOkResponse({ type: [CatalogItemDto] })
  listCatalog(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<CatalogItemDto[]> {
    return this.catalog.list(user.id, id);
  }

  @Get('catalog/sources')
  @ApiOperation({ summary: 'Fotos de cortes de los barberos de la barbería (para importar)' })
  @ApiOkResponse({ type: [CatalogSourceDto] })
  sources(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<CatalogSourceDto[]> {
    return this.catalog.sources(user.id, id);
  }

  @Post('catalog/import')
  @ApiOperation({
    summary: 'Crear un corte del catálogo desde una foto del portafolio de un barbero',
  })
  @ApiCreatedResponse({ type: [CatalogItemDto] })
  importItem(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: ImportCatalogItemDto,
    @Req() req: Request,
  ): Promise<CatalogItemDto[]> {
    return this.catalog.importFromBarber(actorOf(user, req), id, dto);
  }

  @Patch('catalog/:serviceId')
  @ApiOperation({ summary: 'Estilo y foto de portada de un corte del catálogo' })
  @ApiOkResponse({ type: [CatalogItemDto] })
  updateCatalog(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('serviceId', uuid) serviceId: string,
    @Body() dto: UpdateCatalogItemDto,
    @Req() req: Request,
  ): Promise<CatalogItemDto[]> {
    return this.catalog.update(actorOf(user, req), id, serviceId, dto);
  }

  // ── Caja ──

  @Get('cash')
  @ApiOperation({ summary: 'Caja abierta (null si no hay)' })
  @ApiOkResponse({ type: CashSessionDto })
  cash(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<CashSessionDto | null> {
    return this.sales.currentCash(user.id, id);
  }

  @Get('cash/history')
  @ApiOperation({ summary: 'Últimos 30 turnos de caja' })
  @ApiOkResponse({ type: [CashSessionDto] })
  cashHistory(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<CashSessionDto[]> {
    return this.sales.cashHistory(user.id, id);
  }

  @Post('cash/open')
  @ApiOperation({ summary: 'Abrir la caja' })
  @ApiCreatedResponse({ type: CashSessionDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'CASH_SESSION_OPEN' })
  openCash(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: OpenCashDto,
    @Req() req: Request,
  ): Promise<CashSessionDto> {
    return this.sales.openCash(actorOf(user, req), id, dto);
  }

  @Post('cash/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cerrar la caja (con el efectivo contado; calcula la diferencia)' })
  @ApiOkResponse({ type: CashSessionDto })
  closeCash(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CloseCashDto,
    @Req() req: Request,
  ): Promise<CashSessionDto> {
    return this.sales.closeCash(actorOf(user, req), id, dto);
  }

  // ── Ventas ──

  @Get('sales')
  @ApiOperation({ summary: 'Ventas del local (por defecto, las de hoy)' })
  @ApiOkResponse({ type: [SaleDto] })
  listSales(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: SalesQueryDto,
  ): Promise<SaleDto[]> {
    return this.sales.list(user.id, id, query);
  }

  @Post('sales')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'UUID: reintentar no duplica la venta.',
  })
  @ApiOperation({
    summary: 'Registrar una venta en el local (cliente sin reserva), opcionalmente con boleta',
    description:
      'Efectivo exige caja abierta. MEMBERSHIP_CREDIT usa un crédito de la membresía del cliente. ' +
      'La boleta se emite al momento si el proveedor responde; si no, se reintenta sola.',
  })
  @ApiCreatedResponse({ type: SaleDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async createSale(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateSaleDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SaleDto> {
    const { sale, replayed } = await this.sales.create(actorOf(user, req), id, key, dto);
    if (replayed) res.status(HttpStatus.OK);
    return sale;
  }

  @Get('sales/:saleId')
  @ApiOperation({ summary: 'Una venta, con su boleta' })
  @ApiOkResponse({ type: SaleDto })
  sale(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('saleId', uuid) saleId: string,
  ): Promise<SaleDto> {
    return this.sales.get(user.id, id, saleId);
  }

  @Post('sales/:saleId/void')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Anular una venta (con motivo)',
    description:
      'Devuelve el crédito de membresía. Una boleta ya emitida se anula con nota de crédito en el proveedor.',
  })
  @ApiOkResponse({ type: SaleDto })
  voidSale(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('saleId', uuid) saleId: string,
    @Body() dto: VoidSaleDto,
    @Req() req: Request,
  ): Promise<SaleDto> {
    return this.sales.voidSale(actorOf(user, req), id, saleId, dto.reason);
  }

  @Post('sales/:saleId/invoice/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reintentar la boleta de una venta (pendiente o fallida)' })
  @ApiOkResponse({ type: SaleDto })
  retryInvoice(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('saleId', uuid) saleId: string,
  ): Promise<SaleDto> {
    return this.sales.retryInvoice(user.id, id, saleId);
  }

  @Get('invoicing')
  @ApiOperation({ summary: 'Configuración de boletas (nunca devuelve credenciales)' })
  @ApiOkResponse({ type: InvoicingConfigDto })
  invoicing(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<InvoicingConfigDto> {
    return this.sales.invoicingConfig(user.id, id);
  }

  @Put('invoicing')
  @ApiOperation({
    summary: 'Solo OWNER: configurar boletas (FAKE de demostración o NUBEFACT con su RUTA y TOKEN)',
  })
  @ApiOkResponse({ type: InvoicingConfigDto })
  setInvoicing(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateInvoicingConfigDto,
    @Req() req: Request,
  ): Promise<InvoicingConfigDto> {
    return this.sales.updateInvoicingConfig(actorOf(user, req), id, dto);
  }

  // ── Reportes ──

  @Get('reports/sales')
  @ApiOperation({
    summary: 'Reporte de ventas: app y local, por día, barbero, servicio y medio de pago',
  })
  @ApiOkResponse({ type: SalesReportDto })
  report(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: ReportsQueryDto,
  ): Promise<SalesReportDto> {
    return this.reports.sales(user.id, id, query);
  }

  @Get('reports/sales.csv')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Exportar el reporte a CSV (plan con exportación)' })
  @ApiOkResponse({ schema: { type: 'string' } })
  async reportCsv(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: ReportsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const body = await this.reports.salesCsv(user.id, id, query);
    res
      .status(HttpStatus.OK)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', 'attachment; filename="ventas.csv"')
      .setHeader('Cache-Control', 'no-store')
      .send(body);
  }

  @Put('barbers/:barberId/commission')
  @ApiOperation({
    summary: 'Solo OWNER: comisión del barbero sobre sus atenciones (para reportes)',
  })
  @ApiOkResponse({ type: BarberCommissionDto })
  commission(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Param('barberId', uuid) barberId: string,
    @Body() dto: BarberCommissionDto,
  ): Promise<{ commissionBp: number | null }> {
    return this.reports.setBarberCommission(user.id, id, barberId, dto);
  }
}

export const SHOP_QUEUE = 'shop';
const RANKING_JOB = 'shop-ranking';
const INVOICES_JOB = 'shop-invoices';

@Processor(SHOP_QUEUE)
export class ShopProcessor extends WorkerHost {
  constructor(
    private readonly clients: ShopClientsService,
    private readonly sales: SalesService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === RANKING_JOB) await this.clients.recomputeAll();
    else await this.sales.issuePending();
  }
}

/** Ranking cada noche (04:15 de Lima) y boletas pendientes cada 2 minutos. */
@Injectable()
export class ShopScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(SHOP_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.scheduledJobsEnabled) return;
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: 100 };
    await this.queue.upsertJobScheduler(
      RANKING_JOB,
      { pattern: '15 4 * * *', tz: 'America/Lima' },
      { name: RANKING_JOB, opts },
    );
    await this.queue.upsertJobScheduler(
      INVOICES_JOB,
      { every: 120_000 },
      { name: INVOICES_JOB, opts },
    );
  }
}

@Module({
  imports: [
    BarbershopAccessModule,
    ImageStorageModule,
    ServicesModule,
    SettingsModule,
    UsersModule,
    BullModule.registerQueue({ name: SHOP_QUEUE }),
  ],
  controllers: [ShopController],
  providers: [
    ShopClientsService,
    CatalogService,
    SalesService,
    ReportsService,
    FakeInvoiceProvider,
    NubefactInvoiceProvider,
    ShopProcessor,
    ShopScheduler,
  ],
  exports: [ShopClientsService, SalesService],
})
export class ShopModule {}
