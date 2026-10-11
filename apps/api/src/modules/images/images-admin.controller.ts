import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import {
  AdminAccessGuard,
  AdminOnly,
  CurrentStaff,
  type StaffActor,
  SupportOrAdmin,
} from '../admin/admin-access';
import {
  AdminReportedImageDto,
  AdminReportedImagePageDto,
  AdminServiceStyleDto,
  CreateStyleDto,
  ImageModerationDto,
  ReportedImagesQueryDto,
  UpdateStyleDto,
} from './dto/image.dto';
import { ImageModerationService } from './image-moderation.service';

const uuid = new ParseUUIDPipe();

/** Moderación de fotos (soporte o ADMIN) y catálogo de estilos (solo ADMIN). Fase 14. */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@SupportOrAdmin()
@UseGuards(AdminAccessGuard)
@Controller('admin')
export class ImagesAdminController {
  constructor(private readonly moderation: ImageModerationService) {}

  @Get('images/reported')
  @ApiOperation({ summary: 'Fase 14: fotos reportadas (por defecto, con reportes abiertos)' })
  @ApiOkResponse({ type: AdminReportedImagePageDto })
  reported(@Query() query: ReportedImagesQueryDto): Promise<AdminReportedImagePageDto> {
    return this.moderation.reported(query);
  }

  @Post('images/:id/moderation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fase 14: mantener, retirar o restaurar una foto reportada' })
  @ApiOkResponse({ type: AdminReportedImageDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  moderate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ImageModerationDto,
  ): Promise<AdminReportedImageDto> {
    return this.moderation.moderate(staff, id, dto.decision, dto.reason);
  }

  @AdminOnly()
  @Get('service-styles')
  @ApiOperation({ summary: 'Solo ADMIN: estilos, incluidos los inactivos' })
  @ApiOkResponse({ type: [AdminServiceStyleDto] })
  listStyles(): Promise<AdminServiceStyleDto[]> {
    return this.moderation.listStyles();
  }

  @AdminOnly()
  @Post('service-styles')
  @ApiOperation({ summary: 'Solo ADMIN: crear un estilo' })
  @ApiCreatedResponse({ type: AdminServiceStyleDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createStyle(
    @CurrentStaff() staff: StaffActor,
    @Body() dto: CreateStyleDto,
  ): Promise<AdminServiceStyleDto> {
    return this.moderation.createStyle(staff, dto);
  }

  @AdminOnly()
  @Patch('service-styles/:id')
  @ApiOperation({ summary: 'Solo ADMIN: editar o desactivar (nunca borrar) un estilo' })
  @ApiOkResponse({ type: AdminServiceStyleDto })
  updateStyle(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateStyleDto,
  ): Promise<AdminServiceStyleDto> {
    return this.moderation.updateStyle(staff, id, dto);
  }
}
