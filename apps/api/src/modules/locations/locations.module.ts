import { Controller, Get, Global, HttpStatus, Module, Param, Query } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';
import { Public } from '../../common/auth/public.decorator';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { LocationsService } from './locations';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ProvinceDto {
  @ApiProperty({ example: 'Puno' })
  department!: string;

  @ApiProperty({ example: 'San Roman' })
  province!: string;
}

export class DistrictDto {
  @ApiProperty({ example: '211101' })
  ubigeo!: string;

  @ApiProperty({ example: 'Puno' })
  department!: string;

  @ApiProperty({ example: 'San Roman' })
  province!: string;

  @ApiProperty({ example: 'Juliaca' })
  district!: string;

  @ApiProperty({ type: Number, nullable: true })
  latitude!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  longitude!: number | null;
}

export class ProvincesQueryDto {
  @ApiPropertyOptional({ example: 'Puno' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  department?: string;
}

export class DistrictsQueryDto extends ProvincesQueryDto {
  @ApiPropertyOptional({ example: 'San Roman' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  province?: string;

  @ApiPropertyOptional({ description: 'Busca por nombre del distrito (sin tildes).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  q?: string;
}

const toDto = (d: DistrictDto): DistrictDto => ({
  ubigeo: d.ubigeo,
  department: d.department,
  province: d.province,
  district: d.district,
  latitude: d.latitude,
  longitude: d.longitude,
});

/** Lista fija de ubicaciones del Perú (UBIGEO del INEI), para elegir provincia y distrito. */
@ApiTags('locations')
@Public()
@RateLimit('public')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get('departments')
  @ApiOperation({ summary: 'Departamentos del Perú' })
  @ApiOkResponse({ type: [String] })
  departments(): string[] {
    return this.locations.departments();
  }

  @Get('provinces')
  @ApiOperation({ summary: 'Provincias (de un departamento, o todas)' })
  @ApiOkResponse({ type: [ProvinceDto] })
  provinces(@Query() query: ProvincesQueryDto): ProvinceDto[] {
    return this.locations.provinces(query.department);
  }

  @Get('districts')
  @ApiOperation({ summary: 'Distritos (filtra por departamento, provincia o nombre; máximo 300)' })
  @ApiOkResponse({ type: [DistrictDto] })
  districts(@Query() query: DistrictsQueryDto): DistrictDto[] {
    return this.locations.districts(query).map(toDto);
  }

  @Get('districts/:ubigeo')
  @ApiOperation({ summary: 'Un distrito por su UBIGEO' })
  @ApiOkResponse({ type: DistrictDto })
  district(@Param('ubigeo') ubigeo: string): DistrictDto {
    const found = this.locations.byUbigeo(ubigeo);
    if (!found) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El distrito no existe.', HttpStatus.NOT_FOUND);
    }
    return toDto(found);
  }
}

@Global()
@Module({
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
