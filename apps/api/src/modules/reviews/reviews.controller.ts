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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { type Page, PaginationQueryDto } from '../../common/pagination/pagination';
import { type FavoriteDto, FavoritePageDto } from './dto/favorite.dto';
import {
  BarbershopReviewsQueryDto,
  CreateReviewDto,
  CreateReviewReportDto,
  MyReviewDto,
  MyReviewPageDto,
  PublicReviewDto,
  PublicReviewPageDto,
  ReviewResponseInputDto,
  UpdateReviewDto,
} from './dto/review.dto';
import { FavoritesService } from './favorites.service';
import { ReviewWriteRateLimitGuard } from './review-rate-limit';
import { ReviewsService } from './reviews.service';

const uuid = new ParseUUIDPipe();

@ApiTags('reviews')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post('bookings/:id/review')
  @ApiBearerAuth()
  @UseGuards(ReviewWriteRateLimitGuard)
  @ApiOperation({
    summary: 'RF-VAL-001: valorar una reserva atendida (propia, una vez, dentro del plazo)',
    description: 'Plazo: reviews.window_days (14) desde que la reserva quedó ATTENDED.',
  })
  @ApiCreatedResponse({ type: MyReviewDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) bookingId: string,
    @Body() dto: CreateReviewDto,
  ): Promise<MyReviewDto> {
    return this.reviews.create(user.id, bookingId, dto);
  }

  @Patch('reviews/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'RF-VAL-001: editar la valoración propia (una vez, dentro del plazo)' })
  @ApiOkResponse({ type: MyReviewDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateReviewDto,
  ): Promise<MyReviewDto> {
    return this.reviews.update(user.id, id, dto);
  }

  @Delete('reviews/:id')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'RF-VAL-001: retirar la valoración propia' })
  @ApiNoContentResponse()
  retire(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<void> {
    return this.reviews.retire(user.id, id);
  }

  @Get('me/reviews')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'RF-VAL-001: mis valoraciones (las más recientes primero)' })
  @ApiOkResponse({ type: MyReviewPageDto })
  listMine(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationQueryDto,
  ): Promise<Page<MyReviewDto>> {
    return this.reviews.listMine(user.id, query);
  }

  @Public()
  @Get('barbershops/:id/reviews')
  @ApiOperation({
    summary: 'RF-VAL-002: valoraciones públicas de una barbería (las más recientes primero)',
    description: 'Autor como "Ana R.". Nunca datos de contacto.',
  })
  @ApiOkResponse({ type: PublicReviewPageDto })
  listPublic(
    @Param('id', uuid) barbershopId: string,
    @Query() query: BarbershopReviewsQueryDto,
  ): Promise<Page<PublicReviewDto>> {
    return this.reviews.listPublic(barbershopId, query);
  }

  @Put('reviews/:id/response')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'RF-VAL-002: responder (o editar la respuesta) como barbería (OWNER o MANAGER)',
  })
  @ApiOkResponse({ type: PublicReviewDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  respond(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: ReviewResponseInputDto,
  ): Promise<PublicReviewDto> {
    return this.reviews.respond(user.id, id, dto.text);
  }

  @Post('reviews/:id/reports')
  @ApiBearerAuth()
  @UseGuards(ReviewWriteRateLimitGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'RF-VAL-002: reportar una valoración o la respuesta de la barbería',
    description:
      'Una vez por usuario y objetivo. Con reviews.report_threshold (3) reportes pasa a revisión ' +
      'de soporte y sigue visible.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  report(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CreateReviewReportDto,
  ): Promise<void> {
    return this.reviews.report(user.id, id, dto);
  }
}

@ApiTags('favorites')
@ApiBearerAuth()
@Controller('me/favorites')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Put(':barbershopId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'RF-FAV-001: marcar una barbería como favorita (idempotente)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  add(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
  ): Promise<void> {
    return this.favorites.add(user.id, barbershopId);
  }

  @Delete(':barbershopId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'RF-FAV-002: quitar de favoritos (idempotente)' })
  @ApiNoContentResponse()
  remove(
    @CurrentUser() user: AuthUser,
    @Param('barbershopId', uuid) barbershopId: string,
  ): Promise<void> {
    return this.favorites.remove(user.id, barbershopId);
  }

  @Get()
  @ApiOperation({ summary: 'RF-FAV-003: mis barberías favoritas (las más recientes primero)' })
  @ApiOkResponse({ type: FavoritePageDto })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationQueryDto,
  ): Promise<Page<FavoriteDto>> {
    return this.favorites.list(user.id, query);
  }
}
