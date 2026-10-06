import { type AuthUser, OptionalUser } from '../../common/auth/auth-user';
import { Controller, Get, Param, ParseUUIDPipe, Query, UseInterceptors } from '@nestjs/common';
import { PersonalizedResponseInterceptor } from '../../common/http/personalized-response.interceptor';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import {
  AlternativesDto,
  AlternativesQueryDto,
  SearchPageDto,
  SearchQueryDto,
} from './dto/search.dto';
import { SearchService } from './search.service';

/** Endpoints públicos (sin sesión) con límite propio: `search.rate_limit_per_minute` por IP. */
@ApiTags('search')
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@Public()
@RateLimit('search')
@Controller()
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('search/barbershops')
  @UseInterceptors(PersonalizedResponseInterceptor)
  @ApiOperation({
    summary: 'RF-BUS-001…003: buscar barberías (cercanía, texto, categoría, precio, valoración…)',
    description:
      'Solo barberías visibles. La ubicación enviada se usa solo para esta consulta: no se ' +
      'guarda ni se registra.',
  })
  @ApiOkResponse({ type: SearchPageDto })
  barbershops(
    @Query() query: SearchQueryDto,
    @OptionalUser() user: AuthUser | null,
  ): Promise<SearchPageDto> {
    return this.search.search(query, user?.id ?? null);
  }

  @Get('barbershops/:id/alternatives')
  @ApiOperation({
    summary: 'RF-BUS-004: barberías cercanas con la misma categoría de servicio y turnos reales',
  })
  @ApiOkResponse({ type: AlternativesDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  alternatives(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: AlternativesQueryDto,
  ): Promise<AlternativesDto> {
    return this.search.alternatives(id, query);
  }
}
