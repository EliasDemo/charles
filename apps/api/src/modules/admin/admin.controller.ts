import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { type Page, PaginationQueryDto } from '../../common/pagination/pagination';
import { ServicesService } from '../services/services.service';
import type { StaffUserView } from '../users/users.service';
import {
  AdminAccessGuard,
  AdminOnly,
  CurrentStaff,
  type StaffActor,
  SupportOrAdmin,
} from './admin-access';
import { AdminBarbershopsService } from './admin-barbershops.service';
import { AdminOperationsService } from './admin-operations.service';
import { type AdminSetting, AdminSettingsService } from './admin-settings';
import { AdminUsersService, type ManagedRole } from './admin-users.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  AdminBarbershopDetailDto,
  type AdminBarbershopDto,
  AdminBarbershopPageDto,
  AdminBarbershopQueryDto,
  AdminBookingDto,
  AdminCancellationReviewPageDto,
  type AdminCancellationReviewDto,
  AdminCategoryDto,
  type AdminReviewDto,
  AdminReviewPageDto,
  AdminSettingDto,
  CancellationReviewQueryDto,
  CancellationVerdictDto,
  ContactAccessDto,
  ContactDto,
  CreateCategoryDto,
  FindUserQueryDto,
  ManualRefundDto,
  ModerationResultDto,
  ReasonDto,
  RefundRequestedDto,
  ResolveReportsDto,
  ReviewModerationDto,
  StaffUserDto,
  SupportAttendanceCorrectionDto,
  SuspendBarbershopDto,
  SuspensionResultDto,
  UpdateCategoryDto,
  UpdateSettingDto,
  VerdictResultDto,
} from './dto/admin.dto';

const uuid = new ParseUUIDPipe();
const MANAGED_ROLES = ['support', 'admin'] as const;

/** Base común: sesión, soporte o ADMIN (roles leídos de la base) y errores documentados. */
const AdminController = (path: string): ClassDecorator => {
  return (target) => {
    ApiTags('admin')(target);
    ApiBearerAuth()(target);
    ApiForbiddenResponse({ type: ErrorResponseDto })(target);
    ApiNotFoundResponse({ type: ErrorResponseDto })(target);
    SupportOrAdmin()(target);
    UseGuards(AdminAccessGuard)(target);
    Controller(path)(target);
  };
};

// ───────────── Cuentas (RF-OPE-001) ─────────────

@AdminController('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'RF-OPE-001: buscar una cuenta por correo exacto (datos mínimos)' })
  @ApiOkResponse({ type: StaffUserDto })
  find(
    @CurrentStaff() staff: StaffActor,
    @Query() query: FindUserQueryDto,
  ): Promise<StaffUserView> {
    return this.users.findByEmail(staff, query.email);
  }

  @Get(':id')
  @ApiOperation({ summary: 'RF-OPE-001: datos mínimos (nombre, estado y roles)' })
  @ApiOkResponse({ type: StaffUserDto })
  get(@CurrentStaff() staff: StaffActor, @Param('id', uuid) id: string): Promise<StaffUserView> {
    return this.users.get(staff, id);
  }

  @Post(':id/contact')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'RF-OPE-001: ver el contacto (correo y teléfono), con motivo; cada acceso se audita',
  })
  @ApiOkResponse({ type: ContactDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  contact(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ContactAccessDto,
  ): Promise<ContactDto> {
    return this.users.contact(staff, id, dto.reason, dto.ticketId);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'RF-OPE-001: deshabilitar la cuenta (revoca sus sesiones al instante)',
    description:
      'Sus reservas se mantienen; las barberías donde era el único OWNER quedan marcadas para ' +
      'revisión. Soporte no deshabilita cuentas de soporte ni ADMIN.',
  })
  @ApiOkResponse({ type: StaffUserDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  disable(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ReasonDto,
  ): Promise<StaffUserView> {
    return this.users.disable(staff, id, dto.reason);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RF-OPE-001: reactivar la cuenta (con motivo)' })
  @ApiOkResponse({ type: StaffUserDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  enable(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ReasonDto,
  ): Promise<StaffUserView> {
    return this.users.enable(staff, id, dto.reason);
  }

  @Post(':id/roles/:role')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Solo ADMIN: asignar el rol SUPPORT o ADMIN' })
  @ApiParam({ name: 'role', enum: MANAGED_ROLES })
  @ApiOkResponse({ type: StaffUserDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  grant(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Param('role') role: string,
    @Body() dto: ReasonDto,
  ): Promise<StaffUserView> {
    return this.users.grantRole(staff, id, managedRole(role), dto.reason);
  }

  @Delete(':id/roles/:role')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Solo ADMIN: quitar el rol SUPPORT o ADMIN',
    description: 'Nadie se lo quita a sí mismo; nunca al último ADMIN activo (409 LAST_ADMIN).',
  })
  @ApiParam({ name: 'role', enum: MANAGED_ROLES })
  @ApiOkResponse({ type: StaffUserDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  revoke(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Param('role') role: string,
    @Body() dto: ReasonDto,
  ): Promise<StaffUserView> {
    return this.users.revokeRole(staff, id, managedRole(role), dto.reason);
  }
}

function managedRole(role: string): ManagedRole {
  if (role === 'support') return 'SUPPORT';
  if (role === 'admin') return 'ADMIN';
  throw new AppException(
    ErrorCode.NOT_FOUND,
    'Ese rol no se administra aquí.',
    HttpStatus.NOT_FOUND,
  );
}

// ───────────── Barberías (RF-OPE-002) ─────────────

@AdminController('admin/barbershops')
export class AdminBarbershopsController {
  constructor(private readonly barbershops: AdminBarbershopsService) {}

  @Get()
  @ApiOperation({
    summary: 'RF-OPE-002: barberías que necesitan atención (reportes, marcas, pendientes)',
  })
  @ApiOkResponse({ type: AdminBarbershopPageDto })
  list(@Query() query: AdminBarbershopQueryDto): Promise<Page<AdminBarbershopDto>> {
    return this.barbershops.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'RF-OPE-002: barbería con sus reportes abiertos' })
  @ApiOkResponse({ type: AdminBarbershopDetailDto })
  get(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
  ): Promise<AdminBarbershopDetailDto> {
    return this.barbershops.get(staff, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RF-OPE-002: aprobar una barbería PENDING_REVIEW' })
  @ApiOkResponse({ type: AdminBarbershopDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  approve(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ReasonDto,
  ): Promise<AdminBarbershopDetailDto> {
    return this.barbershops.approve(staff, id, dto.reason);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'RF-OPE-002: suspender, decidiendo qué pasa con las reservas futuras',
    description:
      'Por defecto se mantienen las de las próximas 48 h y se cancelan las demás con devolución ' +
      'total; las pendientes de pago se cancelan siempre.',
  })
  @ApiOkResponse({ type: SuspensionResultDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  suspend(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: SuspendBarbershopDto,
  ): Promise<SuspensionResultDto> {
    return this.barbershops.suspend(staff, id, dto);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RF-OPE-002: reactivar una barbería suspendida' })
  @ApiOkResponse({ type: AdminBarbershopDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  reactivate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ReasonDto,
  ): Promise<AdminBarbershopDetailDto> {
    return this.barbershops.reactivate(staff, id, dto.reason);
  }

  @Post(':id/reports/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RF-OPE-002: resolver los reportes abiertos y quitar la marca' })
  @ApiOkResponse({ type: AdminBarbershopDetailDto })
  resolveReports(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ResolveReportsDto,
  ): Promise<AdminBarbershopDetailDto> {
    return this.barbershops.resolveReports(staff, id, dto.resolution);
  }
}

// ───────────── Reservas, pagos, cancelaciones y valoraciones (RF-OPE-003) ─────────────

@AdminController('admin')
export class AdminOperationsController {
  constructor(private readonly operations: AdminOperationsService) {}

  @Get('bookings/:id')
  @ApiOperation({ summary: 'RF-OPE-003: reserva con historial y pagos (datos mínimos)' })
  @ApiOkResponse({ type: AdminBookingDto })
  booking(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
  ): Promise<AdminBookingDto> {
    return this.operations.booking(staff, id);
  }

  @Post('bookings/:id/attendance-correction')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'RF-OPE-003: corregir ATTENDED ↔ NO_SHOW fuera del plazo de 48 h' })
  @ApiOkResponse({ type: AdminBookingDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  correct(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: SupportAttendanceCorrectionDto,
  ): Promise<AdminBookingDto> {
    return this.operations.correctAttendance(staff, id, dto);
  }

  @Post('payments/:id/refunds')
  @AdminOnly()
  @ApiOperation({
    summary: 'Solo ADMIN: reembolso manual, con motivo y hasta lo cobrado',
    description: '409 REFUND_EXCEEDS_PAID si supera lo cobrado y aún no devuelto.',
  })
  @ApiCreatedResponse({ type: RefundRequestedDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  refund(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ManualRefundDto,
  ): Promise<RefundRequestedDto> {
    return this.operations.manualRefund(staff, id, dto);
  }

  @Get('cancellation-reviews')
  @ApiOperation({ summary: 'RF-OPE-003: cancelaciones de barberías por calificar' })
  @ApiOkResponse({ type: AdminCancellationReviewPageDto })
  cancellationReviews(
    @Query() query: CancellationReviewQueryDto,
  ): Promise<Page<AdminCancellationReviewDto>> {
    return this.operations.cancellationReviews(query);
  }

  @Post('cancellation-reviews/:id/verdict')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'RF-OPE-003: calificar una cancelación de la barbería (justificada o no)',
    description: 'Con 3 injustificadas en 30 días la barbería queda suspendida.',
  })
  @ApiOkResponse({ type: VerdictResultDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  verdict(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: CancellationVerdictDto,
  ): Promise<VerdictResultDto> {
    return this.operations.cancellationVerdict(staff, id, dto.verdict, dto.reason);
  }

  @Get('reviews/reported')
  @ApiOperation({ summary: 'RF-OPE-003: valoraciones o respuestas en revisión por reportes' })
  @ApiOkResponse({ type: AdminReviewPageDto })
  reportedReviews(@Query() query: PaginationQueryDto): Promise<Page<AdminReviewDto>> {
    return this.operations.reportedReviews(query);
  }

  @Post('reviews/:id/moderation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'RF-OPE-003: mantener, ocultar o restaurar una valoración o su respuesta',
  })
  @ApiOkResponse({ type: ModerationResultDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  moderate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ReviewModerationDto,
  ): Promise<ModerationResultDto> {
    return this.operations.moderateReview(
      staff,
      id,
      dto.target ?? 'REVIEW',
      dto.decision,
      dto.reason,
    );
  }
}

// ───────────── Solo ADMIN: ajustes y categorías ─────────────

// Los decoradores de clase se aplican de abajo arriba: AdminOnly va encima para prevalecer.
@AdminOnly()
@AdminController('admin')
export class AdminConfigController {
  constructor(
    private readonly settings: AdminSettingsService,
    private readonly services: ServicesService,
    private readonly audit: AuditService,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Solo ADMIN: ajustes con su esquema y si son editables' })
  @ApiOkResponse({ type: [AdminSettingDto] })
  listSettings(): Promise<AdminSetting[]> {
    return this.settings.list();
  }

  @Get('settings/:key')
  @ApiOperation({ summary: 'Solo ADMIN: un ajuste' })
  @ApiOkResponse({ type: AdminSettingDto })
  getSetting(@Param('key') key: string): Promise<AdminSetting> {
    return this.settings.get(key);
  }

  @Put('settings/:key')
  @ApiOperation({
    summary: 'Solo ADMIN: cambiar un ajuste (validado por su esquema y rango)',
    description:
      'Fuera de rango: 400. Claves de seguridad, pagos sensibles o decisiones pendientes: 403 ' +
      'SETTING_READ_ONLY. Queda el valor anterior y el nuevo en audit_log.',
  })
  @ApiOkResponse({ type: AdminSettingDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  updateSetting(
    @CurrentStaff() staff: StaffActor,
    @Param('key') key: string,
    @Body() dto: UpdateSettingDto,
  ): Promise<AdminSetting> {
    return this.settings.update(staff, key, dto.value, dto.reason);
  }

  @Get('service-categories')
  @ApiOperation({ summary: 'Solo ADMIN: categorías de servicio, incluidas las inactivas' })
  @ApiOkResponse({ type: [AdminCategoryDto] })
  listCategories(): Promise<AdminCategoryDto[]> {
    return this.services.listAllCategories();
  }

  @Post('service-categories')
  @ApiOperation({ summary: 'Solo ADMIN: crear una categoría de servicio' })
  @ApiCreatedResponse({ type: AdminCategoryDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async createCategory(
    @CurrentStaff() staff: StaffActor,
    @Body() dto: CreateCategoryDto,
  ): Promise<AdminCategoryDto> {
    const id = await this.services.createCategory({
      key: dto.key,
      name: dto.name,
      sortOrder: dto.sortOrder ?? 0,
    });
    await this.audit.record({
      actorId: staff.id,
      action: 'service_category.created',
      entityType: 'service_category',
      entityId: id,
      changes: { key: dto.key, name: dto.name, actorRole: staff.role },
    });
    return (await this.services.listAllCategories()).find((c) => c.id === id)!;
  }

  @Patch('service-categories/:id')
  @ApiOperation({ summary: 'Solo ADMIN: editar o desactivar (nunca borrar) una categoría' })
  @ApiOkResponse({ type: AdminCategoryDto })
  async updateCategory(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<AdminCategoryDto> {
    const { before, after } = await this.services.updateCategory(id, dto);
    await this.audit.record({
      actorId: staff.id,
      action: 'service_category.updated',
      entityType: 'service_category',
      entityId: id,
      changes: {
        from: { name: before.name, sortOrder: before.sortOrder, isActive: before.isActive },
        to: { name: after.name, sortOrder: after.sortOrder, isActive: after.isActive },
        actorRole: staff.role,
      },
    });
    return after;
  }
}
