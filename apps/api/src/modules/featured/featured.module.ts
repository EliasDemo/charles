import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { AdminAccessGuard, AdminOnly, CurrentStaff, type StaffActor } from '../admin/admin-access';
import { AdminAccessModule } from '../admin/admin-access.module';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { CreateFeaturedDto, FeaturedListingDto, FeaturedQueryDto } from './dto/featured.dto';
import { FeaturedService } from './featured.service';

/** Fase 13: destacados en la búsqueda (solo ADMIN). */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@AdminOnly()
@UseGuards(AdminAccessGuard)
@Controller('admin/featured')
export class FeaturedAdminController {
  constructor(private readonly featured: FeaturedService) {}

  @Get()
  @ApiOperation({ summary: 'Solo ADMIN: destacados vigentes y programados (o todos)' })
  @ApiOkResponse({ type: [FeaturedListingDto] })
  list(@Query() query: FeaturedQueryDto): Promise<FeaturedListingDto[]> {
    return this.featured.list(query.includePast === true);
  }

  @Post()
  @ApiOperation({
    summary: 'Solo ADMIN: destacar una barbería por un periodo',
    description:
      'Hasta 3 destacadas suben al inicio de la primera página de resultados, solo si cumplen ' +
      'los filtros de la búsqueda. Sin cobro por ahora.',
  })
  @ApiCreatedResponse({ type: FeaturedListingDto })
  create(
    @CurrentStaff() staff: StaffActor,
    @Body() dto: CreateFeaturedDto,
  ): Promise<FeaturedListingDto> {
    return this.featured.create(staff.id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Solo ADMIN: retirar un destacado antes de tiempo' })
  @ApiOkResponse({ type: FeaturedListingDto })
  cancel(
    @CurrentStaff() staff: StaffActor,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<FeaturedListingDto> {
    return this.featured.cancel(staff.id, id);
  }
}

@Module({
  imports: [BarbershopAccessModule, AdminAccessModule],
  controllers: [FeaturedAdminController],
  providers: [FeaturedService],
  exports: [FeaturedService],
})
export class FeaturedModule {}
